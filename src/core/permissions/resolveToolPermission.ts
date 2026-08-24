import type { Tool } from "../tools/Tool.ts";
import { throwIfAborted } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { decidePermission } from "./PermissionEngine.ts";
import { promptForPermission, suggestRule } from "./PermissionPrompter.ts";
import { parseRule } from "./PermissionRules.ts";
import { appendAllowRule } from "./settings.ts";
import type { PermissionContext } from "./types.ts";

export interface GateResult {
	allowed: boolean;
	denialReason?: string;
}

const promptTails = new WeakMap<PermissionContext, Promise<void>>();

async function waitForPromptTurn(
	previous: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const abort = () => reject(new Error("aborted"));
		signal.addEventListener("abort", abort, { once: true });
		previous.then(
			() => {
				signal.removeEventListener("abort", abort);
				resolve();
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function withPromptLock<T>(
	pctx: PermissionContext,
	signal: AbortSignal,
	run: () => Promise<T>,
): Promise<T> {
	const previous = promptTails.get(pctx) ?? Promise.resolve();
	let release = (): void => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	promptTails.set(pctx, tail);
	try {
		await waitForPromptTurn(previous, signal);
		throwIfAborted(signal);
		return await run();
	} finally {
		release();
		void tail.then(() => {
			if (promptTails.get(pctx) === tail) promptTails.delete(pctx);
		});
	}
}

/**
 * Resolves a tool call against the permission system. Called by
 * ToolInvocationRunner between pre-tool hooks and execution. Absent
 * ctx.permissions = gate disabled (tests, legacy call sites).
 */
export async function resolveToolPermission(
	tool: Tool,
	input: unknown,
	ctx: ToolContext,
): Promise<GateResult> {
	const pctx = ctx.permissions;
	if (!pctx) return { allowed: true };

	let decision = decidePermission(tool, input, pctx, ctx.cwd);
	if (decision.behavior === "allow") return { allowed: true };
	if (decision.behavior === "deny") {
		return { allowed: false, denialReason: decision.reason };
	}

	// behavior === "ask"
	const unavailable: GateResult = {
		allowed: false,
		denialReason: `Permission required for ${tool.displayName} — permission prompts are unavailable in this context.`,
	};
	if (!pctx.interactive && !pctx.escalate?.()) return unavailable;

	return await withPromptLock(pctx.promptHost ?? pctx, ctx.signal, async () => {
		// Another prompt may have persisted an allow rule while this call waited.
		// Re-evaluate so a parallel batch does not prompt redundantly.
		decision = decidePermission(tool, input, pctx, ctx.cwd);
		if (decision.behavior === "allow") return { allowed: true };
		if (decision.behavior === "deny") {
			return { allowed: false, denialReason: decision.reason };
		}

		const summary = tool.summarizeInput(
			input as Parameters<typeof tool.summarizeInput>[0],
		);
		const base = summary
			? `Allow ${tool.displayName}: ${summary}?`
			: `Allow ${tool.displayName}?`;
		const hint = tool.permissionHint(
			input as Parameters<typeof tool.permissionHint>[0],
		);
		const question = hint ? `${base} ${hint}` : base;
		const prompt = pctx.interactive ? ctx.askUser : pctx.escalate?.();
		if (!prompt) return unavailable;
		throwIfAborted(ctx.signal);
		// Compute the rule up front so the "always" option can disclose its scope.
		const raw = suggestRule(
			tool.agentName,
			decision.content,
			tool.permissionContentIsPaths(
				input as Parameters<typeof tool.permissionContentIsPaths>[0],
			),
		);
		const answer = await promptForPermission(question, raw, prompt, ctx.signal);

		if (answer === "deny") {
			return {
				allowed: false,
				denialReason: "User denied permission for this action.",
			};
		}
		if (answer === "always") {
			const rule = parseRule(raw, "allow");
			if (rule) {
				pctx.rules.allow.push(rule);
				appendAllowRule(ctx.cwd, raw);
			}
		}
		return { allowed: true };
	});
}
