import { resolve } from "node:path";
import { reportDiagnostics } from "../../core/lsp/index.ts";
import type { ToolContext } from "../../core/tools/ToolContext.ts";

const DIAGNOSTICS_BUDGET_MS = 7_000;

/**
 * Runs LSP diagnostics for a just-edited file and returns a model-visible block
 * to append to the tool output, mirroring opencode's post-edit feedback. Fully
 * best-effort: any failure, timeout, or missing LSP yields an empty string so
 * the edit result is never affected.
 */
export async function collectDiagnosticsFeedback(
	ctx: ToolContext,
	filePath: string,
): Promise<string> {
	const lsp = ctx.lsp;
	if (!lsp?.enabled) return "";

	const absolute = resolve(ctx.cwd, filePath);
	try {
		const block = await withBudget(async () => {
			await lsp.touchFile(absolute, { waitForDiagnostics: true });
			const diagnostics = lsp.diagnosticsForFile(absolute);
			return reportDiagnostics(filePath, diagnostics);
		}, DIAGNOSTICS_BUDGET_MS);
		if (!block) return "";
		return `\n\nLSP errors detected in this file, please fix:\n${block}`;
	} catch {
		return "";
	}
}

function withBudget<T>(
	fn: () => Promise<T>,
	ms: number,
): Promise<T | undefined> {
	return new Promise<T | undefined>((resolvePromise) => {
		const timer = setTimeout(() => resolvePromise(undefined), ms);
		timer.unref?.();
		fn().then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			() => {
				clearTimeout(timer);
				resolvePromise(undefined);
			},
		);
	});
}
