import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import {
	asString,
	asStringArray,
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
import { pluralize } from "../utils/string.ts";

const schema = z
	.object({
		// Legacy alias kept for older transcripts and profiles; new prompt
		// contracts document only `patterns`.
		pattern: z
			.string()
			.optional()
			.describe("Deprecated alias for patterns; prefer patterns."),
		// A bare string is coerced to a one-element array in parseInput; the
		// schema stays a plain array because the Backboard API rejects
		// properties without a top-level "type" (anyOf alone is not accepted).
		patterns: z
			.array(z.string())
			.optional()
			.describe(
				'One or more glob patterns combined with OR logic. Examples: ["*.ts"], ["src/**/*.tsx", "src/**/*.css"]. A bare string is also accepted.',
			),
		path: z
			.string()
			.optional()
			.describe(
				"Base directory to search in. If not specified, searches in the current working directory.",
			),
		excludePatterns: z
			.array(z.string())
			.optional()
			.describe("Glob patterns to exclude from results."),
	})
	.refine((input) => input.pattern || (input.patterns?.length ?? 0) > 0, {
		message: "Provide patterns",
	});

type Input = z.infer<typeof schema>;

interface Output {
	files: string[];
	count: number;
}

const MAX_RESULTS = 1000;

export class GlobTool extends Tool<Input, Output> {
	readonly name = "Glob";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override summarizeInput(input: Input): string | undefined {
		const patterns = [...(asStringArray(input.patterns) ?? [])];
		const legacy = asString(input.pattern);
		if (legacy) patterns.unshift(legacy);
		if (patterns.length === 0) return undefined;
		const meta: string[] = [];
		const path = asString(input.path);
		if (path) meta.push(`in ${relativizePath(path)}`);
		const exclude = asStringArray(input.excludePatterns);
		if (exclude) meta.push(`excl ${exclude.join(", ")}`);
		return withMeta(patterns.join(", "), meta);
	}

	override parseInput(raw: unknown): Input {
		// Tolerate a bare string (or JSON-encoded array) for `patterns`.
		if (typeof raw === "object" && raw !== null && "patterns" in raw) {
			const record = raw as Record<string, unknown>;
			return super.parseInput({
				...record,
				patterns: normalizePatterns(record.patterns),
			});
		}
		return super.parseInput(raw);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const cwd = input.path ? resolve(ctx.cwd, input.path) : ctx.cwd;
		const patterns = [...(input.patterns ?? [])];
		if (input.pattern) patterns.unshift(input.pattern);
		const files = await runRipgrepFiles(
			cwd,
			patterns,
			input.excludePatterns ?? [],
			ctx,
		);

		const body = files.length ? files.join("\n") : "No files matched";
		return ok(
			{ files, count: files.length },
			body,
			files.length === 0
				? "No files matched"
				: `Found ${files.length} ${pluralize(files.length, "file")}`,
			buildOutputPreview(files.join("\n"), {
				maxLines: BROWSING_PREVIEW_LINES,
			}),
		);
	}
}

function normalizePatterns(patterns: unknown): unknown {
	if (typeof patterns !== "string") return patterns;
	if (patterns.trimStart().startsWith("[")) {
		try {
			return JSON.parse(patterns);
		} catch {
			return [patterns];
		}
	}
	return [patterns];
}

function runRipgrepFiles(
	cwd: string,
	patterns: string[],
	excludePatterns: string[],
	ctx: ToolContext,
): Promise<string[]> {
	return new Promise((resolvePromise, reject) => {
		if (ctx.signal.aborted) return reject(new Error("aborted"));
		const args = ["--files", "--color=never"];
		for (const pattern of patterns) args.push("--glob", pattern);
		for (const pattern of excludePatterns) args.push("--glob", `!${pattern}`);
		const child = spawn("rg", args, { cwd, signal: ctx.signal });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > 80_000) child.kill("SIGTERM");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => reject(err));
		child.on("close", (code) => {
			if (code !== 0 && code !== 1) {
				reject(new Error(stderr || `ripgrep failed (exit ${code ?? 1})`));
				return;
			}
			resolvePromise(
				stdout.trim() ? stdout.trimEnd().split("\n").slice(0, MAX_RESULTS) : [],
			);
		});
	});
}
