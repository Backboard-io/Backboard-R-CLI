import type { ThinkingRequestKind } from "../../../config/defaults.ts";
import type { AgentClient } from "../../../providers/AgentClient.ts";
import { AbortError } from "../../tools/ToolAbort.ts";
import type { ToolContext } from "../../tools/ToolContext.ts";
import type { AssistantAccumulator } from "../AssistantAccumulator.ts";
import type { ProviderStreamConsumer } from "../ProviderStreamConsumer.ts";
import {
	buildRunMessageRequest,
	type RunMessageRequestContext,
} from "../RunMessageRequestBuilder.ts";
import type { ToolRoundProcessor } from "../ToolRoundProcessor.ts";
import {
	INJECTED_NOTIFICATION_METADATA_KEY,
	type SystemNotification,
	type SystemNotificationContext,
} from "./SystemNotification.ts";

export interface SystemNotificationRunnerDeps extends RunMessageRequestContext {
	client: AgentClient;
	consumer: ProviderStreamConsumer;
	processor: ToolRoundProcessor;
	requestKind: ThinkingRequestKind;
	/**
	 * Recomputes the system prompt at injection time. The turn's prompt is
	 * captured at turn start, but session state it reflects (e.g. the
	 * "TodoWrite was not called yet" reminder) can change mid-turn; injected
	 * requests use the fresh prompt so they never contradict themselves.
	 */
	refreshSystemPrompt?: () => string;
}

/**
 * Injects SystemNotifications after the turn's tool loop finishes. Reuses the
 * turn's ProviderStreamConsumer and ToolRoundProcessor so tool-call dedupe and
 * the round/call counters stay monotonic across the injected turns.
 */
export class SystemNotificationRunner {
	private active: SystemNotification | null = null;
	/**
	 * Tool-call/round counts captured when runPending starts, i.e. the main
	 * turn's totals before any notification injects its own tool calls. The
	 * "will it fire" gate must read these, not the live processor counters:
	 * the main answer's buffering was decided from the same pre-notification
	 * totals, and an earlier notification's bookkeeping calls (e.g. the todo
	 * reminder's TodoWrite) must not push a later one (e.g. final verification)
	 * across its threshold and diverge the two decisions.
	 */
	private frozenCounts: { rounds: number; toolCalls: number } | null = null;

	constructor(
		private readonly deps: SystemNotificationRunnerDeps,
		private readonly notifications: readonly SystemNotification[],
	) {}

	/**
	 * True while the notification currently being injected hides its
	 * response. AgentLoop feeds this to the AssistantAccumulator so the
	 * reply's text streams silently and is discarded instead of shown.
	 */
	activeNotificationHidesResponse(): boolean {
		return this.active?.hidesResponse ?? false;
	}

	/**
	 * True when a notification that supersedes the final answer would fire
	 * right now. AgentLoop's suppressFinalMessage predicate and runPending
	 * both route through the notifications' shouldFire, so the "will it fire"
	 * decision can never diverge between suppression and injection.
	 */
	willSupersedeFinalAnswer(): boolean {
		const context = this.context();
		return this.notifications.some(
			(notification) =>
				notification.supersedesFinalAnswer && notification.shouldFire(context),
		);
	}

	/** Fires each pending notification in order, re-checking shouldFire against the counters as they advance. */
	async runPending(
		turnId: string,
		assistant: AssistantAccumulator,
		ctx: ToolContext,
	): Promise<void> {
		// Freeze the gating counts at the main turn's totals so notifications
		// injected earlier in this pass can't move a later one's fire decision.
		this.frozenCounts = {
			rounds: this.deps.processor.executedRounds,
			toolCalls: this.deps.processor.executedToolCalls,
		};
		try {
			for (const notification of this.notifications) {
				await this.runNotification(notification, turnId, assistant, ctx);
			}
		} finally {
			this.frozenCounts = null;
		}
	}

	/**
	 * Fires one notification, repeating up to its `maxRepeats` while it still
	 * wants to fire. Repeats stop early on a "stall" - a pass that produced the
	 * exact same content as the previous one, meaning the model didn't change
	 * the state the notification reacts to (e.g. left todos open instead of
	 * closing them), so another identical pass would be pointless. This is what
	 * lets the todo reminder loop until the agent closes every todo without
	 * spinning forever when it refuses.
	 */
	private async runNotification(
		notification: SystemNotification,
		turnId: string,
		assistant: AssistantAccumulator,
		ctx: ToolContext,
	): Promise<void> {
		const maxPasses = Math.max(1, notification.maxRepeats ?? 1);
		this.active = notification;
		let previousContent: string | null = null;
		try {
			for (let pass = 0; pass < maxPasses; pass++) {
				if (!notification.shouldFire(this.context())) break;
				const content = notification.content(this.context());
				if (content === previousContent) break;
				previousContent = content;

				const requestContext: SystemNotificationRunnerDeps = {
					...this.deps,
					systemPrompt:
						this.deps.refreshSystemPrompt?.() ?? this.deps.systemPrompt,
					tools: notification.restrictTools
						? notification.restrictTools(this.deps.tools)
						: this.deps.tools,
					metadata: {
						...this.deps.metadata,
						[INJECTED_NOTIFICATION_METADATA_KEY]: notification.id,
					},
				};
				// Stream tool-call prefire: streamed calls render/execute early
				// and finalize reuses the results, same as the main turn.
				const early = this.deps.processor.createEarlyRound(ctx, turnId);
				const pending = await this.deps.consumer.consumeWithRetry(
					() =>
						this.deps.client.runMessage(
							buildRunMessageRequest(
								content,
								requestContext,
								notification.thinking,
							),
							{ signal: ctx.signal },
						),
					assistant,
					ctx.signal,
					early,
				);
				await this.deps.processor.process(
					pending,
					turnId,
					assistant,
					ctx,
					early,
				);
			}
		} catch (err) {
			// A superseding notification owns the turn's shown answer, so its
			// failure must surface. Anything else is best-effort bookkeeping
			// running after the answer already rendered - swallow so it cannot
			// flip a successful turn to failed.
			if (
				err instanceof AbortError ||
				ctx.signal.aborted ||
				notification.supersedesFinalAnswer
			) {
				throw err;
			}
			// A terminal stream error leaves the accumulator's partial segment
			// unfinalized. Drop it so the next notification opens a fresh segment
			// instead of inheriting this one's hidden/buffered flag and having
			// its own (possibly visible) reply silently discarded.
			assistant.discardPartial();
		} finally {
			this.active = null;
		}
	}

	private context(): SystemNotificationContext {
		// Counts are frozen for the duration of runPending (see frozenCounts);
		// todos stay live so the reconciliation loop still sees the model
		// closing items pass to pass.
		return {
			requestKind: this.deps.requestKind,
			executedRounds:
				this.frozenCounts?.rounds ?? this.deps.processor.executedRounds,
			executedToolCalls:
				this.frozenCounts?.toolCalls ?? this.deps.processor.executedToolCalls,
			todos: this.deps.session.todos,
		};
	}
}
