import type { ToolCallRef } from "../bus/events.ts";
import { type HookController, joinHookContext } from "../hooks/index.ts";
import type { Tool } from "./Tool.ts";
import { AbortError, isAbortError } from "./ToolAbort.ts";
import type { ToolContext } from "./ToolContext.ts";

export interface PreToolHookResult {
	input: unknown;
	deniedReason?: string;
	additionalContext?: string;
}

export interface PostToolHookResult {
	output: string;
	additionalContext?: string;
	denied?: boolean;
}

export class ToolHookPipeline {
	constructor(private readonly hookController?: HookController) {}

	async applyPreToolHooks(
		ref: ToolCallRef,
		tool: Tool,
		input: unknown,
		ctx: ToolContext,
	): Promise<PreToolHookResult> {
		const preTool = await this.hookController?.runPreToolUse({
			turnId: ctx.turnId,
			sessionId: ctx.sessionId,
			cwd: ctx.cwd,
			toolCallId: ref.id,
			toolName: ref.name,
			toolInput: input,
			signal: ctx.signal,
		});
		if (!preTool) return { input };
		return {
			input: preTool.input !== input ? tool.parseInput(preTool.input) : input,
			deniedReason: preTool.deniedReason,
			additionalContext: preTool.additionalContext,
		};
	}

	async applyPostToolHooks(
		ref: ToolCallRef,
		input: unknown,
		output: string,
		isError: boolean,
		ctx: ToolContext,
	): Promise<PostToolHookResult> {
		const postTool = await this.hookController?.runPostToolUse({
			turnId: ctx.turnId,
			sessionId: ctx.sessionId,
			cwd: ctx.cwd,
			toolCallId: ref.id,
			toolName: ref.name,
			toolInput: input,
			output,
			isError,
			signal: ctx.signal,
		});
		return {
			output: postTool?.output ?? output,
			additionalContext: postTool?.additionalContext,
			denied: postTool?.denied,
		};
	}
}

export function mergeHookContext(
	output: string,
	preContext: string | undefined,
	postContext: string | undefined,
): string {
	const context = joinHookContext(preContext, postContext);
	if (!context) return output;
	return `${output}\n\nHook context:\n${context}`;
}

export function normalizeAbort(err: unknown, signal: AbortSignal): void {
	if (isAbortError(err) || signal.aborted) throw new AbortError();
}
