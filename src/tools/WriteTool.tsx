import { writeFile } from "node:fs/promises";
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
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { ensureDir, fileExists } from "../utils/fs.ts";
import { withPathLocks } from "../utils/pathLocks.ts";
import { collectDiagnosticsFeedback } from "./fileEdits/diagnosticsFeedback.ts";

const schema = z.object({
	file_path: z.string().describe("The path to the file to write"),
	content: z.string().describe("The complete file contents"),
});

type Input = z.infer<typeof schema>;

interface Output {
	filePath: string;
	bytes: number;
}

export class WriteTool extends Tool<Input, Output> {
	readonly name = "Write";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override permissionContent(input: Input): string {
		return input.file_path;
	}

	override permissionContentIsPaths(): boolean {
		return true;
	}

	override permissionPaths(input: Input): readonly string[] {
		return [input.file_path];
	}

	override checkPermissions(
		input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (ctx.mode !== "acceptEdits" && ctx.mode !== "auto") return undefined;
		if (pathsInsideCwd([input.file_path], ctx.cwd)) {
			return {
				behavior: "allow",
				reason: `edit inside working directory (${ctx.mode})`,
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
		const filePath = resolve(ctx.cwd, input.file_path);
		return await withPathLocks([filePath], async () => {
			// Journal the pre-image (and any directories this write is about to
			// create, so undo can prune them) before touching disk.
			const createdDirs = await missingAncestorDirs(dirname(filePath));
			await ctx.checkpoints?.recordPreImage(filePath, ctx, {
				createdDirs,
				tool: this.name,
			});
			await ensureDir(dirname(filePath));
			await writeFile(filePath, input.content, "utf8");
			await ctx.checkpoints?.recordPostImage(
				filePath,
				ctx,
				Buffer.from(input.content, "utf8"),
			);

			const bytes = Buffer.byteLength(input.content, "utf8");
			const diagnostics = await collectDiagnosticsFeedback(ctx, filePath);
			return ok(
				{ filePath, bytes },
				`Wrote ${input.file_path} (${bytes} bytes)${diagnostics}`,
				`Wrote ${input.file_path}`,
			);
		});
	}
}

/**
 * Ancestor directories of `dir` (inclusive) that do not exist yet — the
 * directories `ensureDir` is about to create, deepest first.
 */
async function missingAncestorDirs(dir: string): Promise<string[]> {
	const missing: string[] = [];
	let current = dir;
	while (!(await fileExists(current))) {
		missing.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return missing;
}
