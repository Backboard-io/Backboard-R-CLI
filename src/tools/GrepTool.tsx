import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import {
	asString,
	relativizePath,
	withMeta,
} from "../core/tools/inputSummary.ts";
import {
	BROWSING_PREVIEW_LINES,
	buildOutputPreview,
} from "../core/tools/outputPreview.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const schema = z.object({
	pattern: z
		.string()
		.describe(
			"A search pattern to match in file contents. Can be a literal string or a regular expression. Supports ripgrep regex syntax.",
		),
	path: z
		.string()
		.optional()
		.describe(
			"Path to a file or directory to search in. If not specified, searches in the current working directory.",
		),
	glob: z
		.string()
		.optional()
		.describe(
			'Glob pattern to filter files. Example: "*.js" for JavaScript files.',
		),
	fixed_string: z
		.boolean()
		.optional()
		.describe(
			"Treat the pattern as a literal string instead of a regex (ripgrep -F). Use for special characters like ?, *, (, [.",
		),
	ignore_case: z
		.boolean()
		.optional()
		.describe("Perform case-insensitive matching."),
	type: z
		.string()
		.optional()
		.describe("Ripgrep file type filter. Examples: js, py, rust, cpp."),
	context_before: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show before each match. Only works with output_mode="content".',
		),
	context_after: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show after each match. Only works with output_mode="content".',
		),
	context: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Number of lines to show before and after each match. Only works with output_mode="content".',
		),
	line_numbers: z
		.boolean()
		.optional()
		.describe(
			'Show line numbers in output. Only works with output_mode="content".',
		),
	multiline: z
		.boolean()
		.optional()
		.describe(
			"Enable multiline mode where . matches newlines and patterns can span lines.",
		),
	output_mode: z
		.enum(["content", "file_paths"])
		.optional()
		.describe(
			'"file_paths" returns only matching file paths, "content" returns matching lines with optional context and line numbers.',
		),
	head_limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Limit output to the first N lines. Works with both output modes.",
		),
});

type Input = z.infer<typeof schema>;

interface Output {
	matches: string;
	matchCount: number;
}

const MAX_OUTPUT = 40_000;

export class GrepTool extends Tool<Input, Output> {
	readonly name = "Grep";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override summarizeInput(input: Input): string | undefined {
		const pattern = asString(input.pattern);
		if (!pattern) return undefined;
		const filters: string[] = [];
		const glob = asString(input.glob);
		if (glob) filters.push(glob);
		const type = asString(input.type);
		if (type) filters.push(type);
		const path = asString(input.path);
		if (path) filters.push(relativizePath(path));
		return withMeta(
			pattern.replace(/\s+/g, " ").trim(),
			filters.length ? [`in ${filters.join(", ")}`] : [],
		);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const searchPath = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
		const outputMode = input.output_mode ?? "content";
		const args = ["--no-heading", "--color=never"];
		if (outputMode === "file_paths") args.push("--files-with-matches");
		if (outputMode === "content" && input.line_numbers !== false) {
			args.push("--line-number");
		}
		if (input.fixed_string) args.push("--fixed-strings");
		if (input.ignore_case) args.push("--ignore-case");
		if (input.glob) args.push("--glob", input.glob);
		if (input.type) args.push("--type", input.type);
		if (input.multiline) args.push("--multiline", "--multiline-dotall");
		if (input.context !== undefined) {
			args.push("--context", String(input.context));
		} else {
			if (input.context_before !== undefined) {
				args.push("--before-context", String(input.context_before));
			}
			if (input.context_after !== undefined) {
				args.push("--after-context", String(input.context_after));
			}
		}
		args.push("--regexp", input.pattern, searchPath);

		const { stdout, code } = await run("rg", args, ctx);

		// rg exit code 1 = no matches (not an error); >1 = real error.
		if (code !== 0 && code !== 1) {
			throw new Error(`ripgrep failed (exit ${code})`);
		}

		let limited = stdout;
		let truncationNote = "";
		if (input.head_limit !== undefined && limited) {
			const lines = limited.trimEnd().split("\n");
			if (lines.length > input.head_limit) {
				limited = `${lines.slice(0, input.head_limit).join("\n")}\n`;
				truncationNote = `[output truncated to first ${input.head_limit} lines by head_limit]\n`;
			}
		}
		const trimmed =
			limited.length > MAX_OUTPUT ? limited.slice(0, MAX_OUTPUT) : limited;
		const matchCount = trimmed ? trimmed.trimEnd().split("\n").length : 0;
		const summary =
			matchCount === 0 ? "No matches found" : trimmed + truncationNote;

		return ok(
			{ matches: summary, matchCount },
			summary,
			matchCount === 0
				? "No matches found"
				: `Found ${matchCount} match${matchCount === 1 ? "" : "es"}`,
			buildOutputPreview(trimmed, { maxLines: BROWSING_PREVIEW_LINES }),
		);
	}
}

function run(
	cmd: string,
	args: string[],
	ctx: ToolContext,
): Promise<{ stdout: string; code: number }> {
	return new Promise((resolvePromise, reject) => {
		if (ctx.signal.aborted) return reject(new Error("aborted"));
		const child = spawn(cmd, args, { signal: ctx.signal });
		let stdout = "";
		child.stdout?.on("data", (c) => {
			stdout += c.toString();
			if (stdout.length > MAX_OUTPUT * 2) child.kill("SIGTERM");
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => resolvePromise({ stdout, code: code ?? 1 }));
	});
}
