import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { pathsInsideCwd } from "../core/permissions/pathsInside.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { ToolResultDetailLine } from "../core/tools/ToolResultDetail.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir, fileExists } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
import { collectDiagnosticsFeedback } from "./fileEdits/diagnosticsFeedback.ts";
import { buildEditDiffDetailLines } from "./fileEdits/diffPreview.ts";
import {
	applyPatchUpdate,
	contentFromAddedLines,
	type PatchOperation,
	parsePatch,
} from "./fileEdits/patch.ts";
import { lineSummary } from "./fileEdits/textReplacements.ts";

const schema = z.object({
	patch: z.string().describe("Patch text to apply"),
});

type Input = z.infer<typeof schema>;

interface Output {
	files: string[];
	operations: number;
}

/** Every path a patch would touch, or null when it does not parse. */
function patchPaths(patch: string): string[] | null {
	try {
		return parsePatch(patch).flatMap(operationPaths);
	} catch {
		return null;
	}
}

/**
 * Joins paths so their boundaries survive the round trip into a rule string.
 * A patch header takes the whole rest of the line as the path, so a path may
 * contain spaces: joining raw would let the single path `src/file ../secret`
 * encode identically to the pair `src/file` + `../secret`, and a grant
 * approved for the first would silently authorize the second. Escaping the
 * separator and the escape itself keeps the two distinct.
 */
function encodePathList(paths: readonly string[]): string {
	return paths
		.map((path) => path.replaceAll("\\", "\\\\").replaceAll(" ", "\\ "))
		.join(" ");
}

export class ApplyPatchTool extends Tool<Input, Output> {
	readonly name = "ApplyPatch";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	/**
	 * The paths the patch touches, so rules and "always allow" scope to files
	 * the way Edit and Write do. Without this the persisted grant is a bare
	 * `apply_patch`, which allows every future patch to every file.
	 */
	override permissionContent(input: Input): string | undefined {
		const paths = patchPaths(input.patch);
		return paths && paths.length > 0 ? encodePathList(paths) : undefined;
	}

	override permissionContentIsPaths(): boolean {
		return true;
	}

	override permissionPaths(input: Input): readonly string[] | undefined {
		return patchPaths(input.patch) ?? undefined;
	}

	override checkPermissions(
		input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		// A patch that does not parse cannot apply; deny rather than prompt, so
		// an "always allow" can never persist an unscopeable grant.
		if (patchPaths(input.patch) === null) {
			return {
				behavior: "deny",
				reason: "Patch could not be parsed, so no files were identified.",
			};
		}
		if (ctx.mode !== "acceptEdits" && ctx.mode !== "auto") return undefined;
		const paths = patchPaths(input.patch);
		if (paths !== null && paths.length > 0 && pathsInsideCwd(paths, ctx.cwd)) {
			return {
				behavior: "allow",
				reason: `patch inside working directory (${ctx.mode})`,
			};
		}
		return undefined;
	}

	override isConcurrencySafe(): boolean {
		return true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const operations = parsePatch(input.patch);
		const resolvedPaths = operations
			.flatMap(operationPaths)
			.map((path) => resolve(ctx.cwd, path));

		return await withPathLocks(resolvedPaths, async () => {
			const actions: Array<
				| { kind: "write"; path: string; content: string }
				| { kind: "delete"; path: string }
			> = [];
			const detailLines: ToolResultDetailLine[] = [];
			let addedLines = 0;
			let removedLines = 0;
			for (const operation of operations) {
				const filePath = resolve(ctx.cwd, operation.path);
				if (operation.kind === "add") {
					if (await fileExists(filePath)) {
						throw new Error(`File already exists: ${operation.path}`);
					}
					const content = contentFromAddedLines(operation.lines, "\n");
					actions.push({
						kind: "write",
						path: filePath,
						content,
					});
					addedLines += operation.lines.length;
					detailLines.push(
						...prefixDetailLineKeys(
							operation.path,
							buildEditDiffDetailLines(operation.path, "", content),
						),
					);
					continue;
				}

				if (operation.kind === "delete") {
					const original = await readRegularFile(filePath, operation.path);
					actions.push({ kind: "delete", path: filePath });
					removedLines += countContentLines(original);
					detailLines.push(
						...prefixDetailLineKeys(
							operation.path,
							buildEditDiffDetailLines(operation.path, original, ""),
						),
					);
					continue;
				}

				const original = await readFile(filePath, "utf8");
				const content = applyPatchUpdate(
					original,
					operation.hunks,
					operation.path,
				);
				const outputPath = operation.movePath
					? resolve(ctx.cwd, operation.movePath)
					: filePath;
				if (operation.movePath && (await fileExists(outputPath))) {
					throw new Error(`File already exists: ${operation.movePath}`);
				}
				actions.push({
					kind: "write",
					path: outputPath,
					content,
				});
				if (operation.movePath)
					actions.push({ kind: "delete", path: filePath });
				for (const hunk of operation.hunks) {
					addedLines += hunk.addedLineCount;
					removedLines += hunk.removedLineCount;
				}
				const displayPath = operation.movePath ?? operation.path;
				detailLines.push(
					...prefixDetailLineKeys(
						displayPath,
						buildEditDiffDetailLines(displayPath, original, content),
					),
				);
			}

			// Pre-image every touched path before the first disk op (a move's
			// source and destination are both journaled before either changes),
			// then apply; a mid-loop failure rolls the whole patch back so it
			// behaves atomically. requireRevertible refuses paths whose pre-image
			// cannot be captured (over the size cap) before anything is mutated,
			// so the rollback guarantee stays honest.
			for (const action of actions) {
				await ctx.checkpoints?.recordPreImage(action.path, ctx, {
					tool: this.name,
					requireRevertible: true,
				});
			}
			try {
				for (const action of actions) {
					if (action.kind === "delete") {
						await unlink(action.path);
						await ctx.checkpoints?.recordPostImage(action.path, ctx);
						continue;
					}
					await ensureDir(dirname(action.path));
					await writeFile(action.path, action.content, "utf8");
					await ctx.checkpoints?.recordPostImage(
						action.path,
						ctx,
						Buffer.from(action.content, "utf8"),
					);
				}
			} catch (error) {
				await ctx.checkpoints?.revertToolCall(ctx.toolCallId ?? "unknown");
				throw error;
			}

			const writtenPaths = [
				...new Set(
					actions
						.filter((action) => action.kind === "write")
						.map((action) => action.path),
				),
			];
			let diagnostics = "";
			for (const path of writtenPaths) {
				diagnostics += await collectDiagnosticsFeedback(ctx, path);
			}

			return ok(
				{
					files: [...new Set(operations.flatMap(operationPaths))],
					operations: operations.length,
				},
				`Applied patch to ${operations.length} operation(s)${diagnostics}`,
				lineSummary(addedLines, removedLines),
				undefined,
				detailLines,
			);
		});
	}
}

function prefixDetailLineKeys(
	filePath: string,
	lines: readonly ToolResultDetailLine[],
): ToolResultDetailLine[] {
	return lines.map((line) => ({
		...line,
		key: `${filePath}:${line.key}`,
	}));
}

async function readRegularFile(
	filePath: string,
	displayPath: string,
): Promise<string> {
	const info = await stat(filePath);
	if (!info.isFile()) throw new Error(`Not a file: ${displayPath}`);
	return await readFile(filePath, "utf8");
}

function countContentLines(content: string): number {
	if (content.length === 0) return 0;
	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	return normalized.endsWith("\n")
		? normalized.split("\n").length - 1
		: normalized.split("\n").length;
}

function operationPaths(operation: PatchOperation): string[] {
	if (operation.kind === "update" && operation.movePath) {
		return [operation.path, operation.movePath];
	}
	return [operation.path];
}
