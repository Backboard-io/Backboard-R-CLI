import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import { resolveToolPermission } from "../permissions/resolveToolPermission.ts";
import { throwIfAborted } from "./ToolAbort.ts";
import type { ToolContext } from "./ToolContext.ts";
import { toolResultEvent, toolStartEvent } from "./ToolEventFactory.ts";
import type { ExecutablePlanEntry } from "./ToolExecutionPlanner.ts";
import {
	mergeHookContext,
	normalizeAbort,
	type ToolHookPipeline,
} from "./ToolHookPipeline.ts";
import type { ToolOutput } from "./ToolScheduler.ts";

export class ToolInvocationRunner {
	constructor(
		private readonly bus: EventBus,
		private readonly hooks: ToolHookPipeline,
	) {}

	async run(entry: ExecutablePlanEntry, ctx: ToolContext): Promise<ToolOutput> {
		const { ref } = entry;
		let hookInput = entry.input;
		let deniedReason: string | undefined;
		let preToolContext: string | undefined;
		try {
			const preTool = await this.hooks.applyPreToolHooks(
				ref,
				entry.tool,
				entry.input,
				ctx,
			);
			hookInput = preTool.input;
			deniedReason = preTool.deniedReason;
			preToolContext = preTool.additionalContext;
		} catch (err) {
			normalizeAbort(err, ctx.signal);
			const message = `Error: pre-tool hook failed for "${ref.name}": ${errorMessage(err)}`;
			this.bus.emit(toolStartEvent(ref, entry.input, entry.tool));
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: { name: ref.name, readOnly: false, error: true },
			};
		}

		// No events once the turn is aborted - the scheduler has already
		// rejected, and a late emit would resurrect a committed transcript row.
		throwIfAborted(ctx.signal);
		this.bus.emit(toolStartEvent(ref, hookInput, entry.tool));

		if (deniedReason) {
			const message = `Error: ${deniedReason}`;
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: true,
				},
			};
		}

		// Permission gate: after hooks (hooks keep first-deny rights), before
		// execution. A denial mirrors the hook-denial shape so the model sees
		// a normal tool error and the turn continues.
		if (ctx.permissions) {
			let gate: Awaited<ReturnType<typeof resolveToolPermission>>;
			try {
				gate = await resolveToolPermission(entry.tool, hookInput, ctx);
			} catch (err) {
				normalizeAbort(err, ctx.signal);
				throw err;
			}
			throwIfAborted(ctx.signal);
			if (!gate.allowed) {
				const message = `Error: ${gate.denialReason ?? "Permission denied."}`;
				this.emitError(ref.id, entry.tool.displayName, message);
				return {
					tool_call_id: ref.id,
					output: message,
					metadata: {
						name: ref.name,
						readOnly: entry.tool.isReadOnly(hookInput),
						error: true,
					},
				};
			}
		}

		try {
			const result = await entry.tool.execute(hookInput, {
				...ctx,
				toolCallId: ref.id,
				trace: ctx.trace?.forToolCall(ref.id),
			});
			// A completion after cancel stays silent; its output is discarded.
			throwIfAborted(ctx.signal);
			const post = await this.hooks.applyPostToolHooks(
				ref,
				hookInput,
				result.forLLM,
				false,
				ctx,
			);
			// The post-hook await is another suspension point - a cancel that
			// lands while it runs must not emit tool:result or tool:error.
			throwIfAborted(ctx.signal);
			if (post.denied) {
				this.emitError(ref.id, entry.tool.displayName, post.output);
				return {
					tool_call_id: ref.id,
					output: post.output,
					metadata: {
						name: ref.name,
						readOnly: entry.tool.isReadOnly(hookInput),
						error: true,
					},
				};
			}
			const output = mergeHookContext(
				post.output,
				preToolContext,
				post.additionalContext,
			);
			this.bus.emit(
				toolResultEvent(
					ref,
					entry.tool,
					result.data,
					result.title,
					result.detail,
					result.detailLines,
				),
			);
			return {
				tool_call_id: ref.id,
				output,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: false,
				},
			};
		} catch (err) {
			normalizeAbort(err, ctx.signal);
			const post = await this.hooks.applyPostToolHooks(
				ref,
				hookInput,
				`Error: ${errorMessage(err)}`,
				true,
				ctx,
			);
			// A cancel landing during that await must stay silent here too.
			throwIfAborted(ctx.signal);
			const message = post.denied
				? post.output
				: mergeHookContext(post.output, preToolContext, post.additionalContext);
			this.emitError(ref.id, entry.tool.displayName, message);
			return {
				tool_call_id: ref.id,
				output: message,
				metadata: {
					name: ref.name,
					readOnly: entry.tool.isReadOnly(hookInput),
					error: true,
				},
			};
		}
	}

	private emitError(toolCallId: string, name: string, error: string): void {
		this.bus.emit({
			type: "tool:error",
			toolCallId,
			name,
			error,
		});
	}
}
