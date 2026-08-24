import type { ReactNode } from "react";
import type { z } from "zod";
import type { PromptContext } from "../../prompts/PromptModule.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../permissions/types.ts";
import type { AgentMode } from "./AgentToolOutput.ts";
import { toAgentToolName } from "./names.ts";
import { type OpenAITool, toOpenAITool } from "./schema.ts";
import type { ToolContext } from "./ToolContext.ts";
import type { ToolResult } from "./ToolResult.ts";

/**
 * Abstract base for every tool. Subclasses declare their name, Zod input
 * schema, and `execute` logic; everything else has sane defaults. Concurrency
 * and destructiveness defaults are conservative: a tool is parallel-safe only
 * if it is read-only.
 *
 * `prompt()` returns the tool's model-facing description, sourced from
 * `prompts/tools/*` (empty placeholders for now).
 */
export abstract class Tool<I = unknown, O = unknown> {
	abstract readonly name: string;
	abstract readonly inputSchema: z.ZodType<I>;

	get agentName(): string {
		return toAgentToolName(this.name);
	}

	get displayName(): string {
		return this.name;
	}

	/** Model-facing description. Empty until prompts are authored. */
	prompt(_context: PromptContext = {}): string {
		return "";
	}

	isReadOnly(_input: I): boolean {
		return true;
	}

	isConcurrencySafe(input: I): boolean {
		return this.isReadOnly(input);
	}

	isDestructive(_input: I): boolean {
		return false;
	}

	/**
	 * Tool-specific permission verdict. Return undefined for "no opinion" —
	 * the permission engine then falls through to rules and mode defaults.
	 */
	checkPermissions(
		_input: I,
		_ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		return undefined;
	}

	/**
	 * The string permission rules match against (a command for Execute, a
	 * file path for file tools). Undefined = only bare tool rules match.
	 */
	permissionContent(_input: I): string | undefined {
		return undefined;
	}

	/**
	 * True when permissionContent is a list of paths rather than a command.
	 * A persisted grant then covers exactly those paths: prefix generalization
	 * on a path list would let a later call append unapproved paths and match.
	 */
	permissionContentIsPaths(_input: I): boolean {
		return false;
	}

	/**
	 * Raw path boundaries for path-list permission matching. Aggregate
	 * permissionContent remains the persisted exact-rule surface; this list lets
	 * configured globs authorize every path independently.
	 */
	permissionPaths(_input: I): readonly string[] | undefined {
		return undefined;
	}

	/**
	 * Extra sentence appended to this call's permission prompt, e.g. pointing
	 * at a config switch that would skip the prompt. Undefined = no addendum.
	 */
	permissionHint(_input: I): string | undefined {
		return undefined;
	}

	abstract execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;

	/** Optional lifecycle cleanup for tools that hold external resources. */
	async dispose(): Promise<void> {}

	/**
	 * One-line parameter summary shown beneath the tool name in the transcript.
	 * Override to surface the parameters that explain a call (a command, a search
	 * pattern, a path + line range); return `undefined` to use the generic
	 * free-form fallback. The result is whitespace-collapsed and length-clamped by
	 * the caller, so return the raw human-readable summary.
	 */
	summarizeInput(_input: I): string | undefined {
		return undefined;
	}

	agentModeForInput(_input: I): AgentMode | undefined {
		return undefined;
	}

	/** UI rendering of the invocation line. Overridable per tool. */
	renderCall(_input: I): ReactNode {
		return null;
	}

	/** UI rendering of the result block. Overridable per tool. */
	renderResult(_output: O): ReactNode {
		return null;
	}

	parseInput(raw: unknown): I {
		return this.inputSchema.parse(stripNullProps(raw));
	}

	toJSONSchema(context: PromptContext = {}): OpenAITool {
		return toOpenAITool(this.agentName, this.prompt(context), this.inputSchema);
	}
}

/**
 * Models routinely send `null` for optional parameters. Zod's `.optional()`
 * rejects null, so we drop null-valued top-level keys before validation. This
 * keeps the advertised schema clean (optional, not nullable) while tolerating
 * the common null-for-omitted convention.
 */
export function stripNullProps(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (value !== null) out[key] = value;
	}
	return out;
}
