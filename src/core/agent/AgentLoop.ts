import type {
	DynamicThinkingEvidence,
	MemoryMode,
	MemoryProfile,
	ThinkingConfig,
	ThinkingRequestKind,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type {
	AgentClient,
	RunMessageOptions,
} from "../../providers/AgentClient.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus } from "../bus/events.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import { AssistantAccumulator } from "./AssistantAccumulator.ts";
import { finalVerificationNotification } from "./notifications/FinalVerificationNotification.ts";
import { SystemNotificationRunner } from "./notifications/SystemNotificationRunner.ts";
import { todoReconciliationNotification } from "./notifications/TodoReconciliationNotification.ts";
import { ProviderStreamConsumer } from "./ProviderStreamConsumer.ts";
import { buildRunMessageRequest } from "./RunMessageRequestBuilder.ts";
import { hasStructuralDiagnosticText } from "./ThinkingEvidence.ts";
import { ToolRoundProcessor } from "./ToolRoundProcessor.ts";
import { Turn } from "./Turn.ts";

export interface AgentLoopDeps {
	client: AgentClient;
	scheduler: ToolScheduler;
	session: Session;
	bus: EventBus;
	tools: OpenAITool[];
	systemPrompt: string;
	/** Recomputes the system prompt for injected notification requests; see SystemNotificationRunnerDeps. */
	refreshSystemPrompt?: () => string;
	assistantId?: string;
	model: { provider: string; model: string };
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	thinking: ThinkingConfig | null | undefined;
	thinkingResolver?: RuntimeThinkingResolver;
	requestKind?: ThinkingRequestKind;
	finalVerificationNudge?: boolean;
	turnId?: string;
	turnStartedAt?: number;
	turnAlreadyStarted?: boolean;
	maxToolRounds?: number;
	attachmentFilePaths?: string[];
	displayContent?: string;
	durableSession?: RunMessageOptions["durableSession"];
}

/**
 * The provider-agnostic turn engine. It drives one user turn to completion:
 * send the message, process the provider event stream, and while the run
 * requires action, execute tools and submit their outputs - looping until the
 * run completes or fails. Cancellation propagates as AbortError; no partial
 * tool outputs are submitted on cancel.
 */
export class AgentLoop {
	private executedToolRounds = 0;

	constructor(private readonly deps: AgentLoopDeps) {}

	/** Tool-call rounds executed in the last run. */
	get toolRounds(): number {
		return this.executedToolRounds;
	}

	async run(content: string, ctx: ToolContext): Promise<TurnStatus> {
		const { bus, session } = this.deps;
		const turn = new Turn(this.deps.turnId, this.deps.turnStartedAt);
		if (!this.deps.turnAlreadyStarted) {
			bus.emit({ type: "turn:start", turnId: turn.id });
		}

		const consumer = new ProviderStreamConsumer(bus, session);
		const processor = new ToolRoundProcessor({
			client: this.deps.client,
			scheduler: this.deps.scheduler,
			session,
			bus,
			consumer,
			tools: this.deps.tools,
			resolveThinking: (evidence) => this.resolveThinking(evidence),
			requestKind: this.deps.requestKind ?? "user",
			maxToolRounds: this.deps.maxToolRounds,
		});
		this.executedToolRounds = 0;

		const notifications = new SystemNotificationRunner(
			{
				client: this.deps.client,
				session,
				consumer,
				processor,
				tools: this.deps.tools,
				systemPrompt: this.deps.systemPrompt,
				refreshSystemPrompt: this.deps.refreshSystemPrompt,
				assistantId: this.deps.assistantId,
				model: this.deps.model,
				memory: this.deps.memory,
				memoryProfile: this.deps.memoryProfile,
				workspaceId: this.deps.workspaceId,
				requestKind: this.deps.requestKind ?? "user",
			},
			[
				// Resolve the plan first: loop the todo reminder until the agent
				// has closed every todo, then let verification review the finished
				// work and produce the shown summary.
				todoReconciliationNotification(),
				finalVerificationNotification(
					this.deps.finalVerificationNudge ?? false,
				),
			],
		);

		// Until the notification passes start, a final (no-tool-call) answer that
		// follows at least one tool round is only a preview of what a superseding
		// notification is about to re-answer - buffer it so it's discarded instead
		// of shown, and the notification pass's answer becomes the only summary.
		let notificationsStarted = false;
		const assistant = new AssistantAccumulator(turn.id, bus, session, {
			suppressFinalMessage: () =>
				!notificationsStarted && notifications.willSupersedeFinalAnswer(),
			suppressAllMessages: () =>
				notifications.activeNotificationHidesResponse(),
		});

		try {
			const initialThinking = this.resolveThinking({
				phase: "initial",
				requestKind: this.deps.requestKind ?? "user",
				hasDiagnosticText: hasStructuralDiagnosticText(content),
			});
			const messageOptions = {
				signal: ctx.signal,
				attachmentFilePaths: this.deps.attachmentFilePaths,
				displayContent: this.deps.displayContent,
				durableSession: this.deps.durableSession,
			};
			const buildMessageRequest = () =>
				buildRunMessageRequest(content, this.deps, initialThinking);
			const createMessageStream = () =>
				this.deps.client.runMessage(buildMessageRequest(), messageOptions);

			const early = processor.createEarlyRound(ctx, turn.id);
			const pending = await consumer.consumeWithRetry(
				createMessageStream,
				assistant,
				ctx.signal,
				early,
				() =>
					this.deps.client.preserveFailedMessage?.(
						buildMessageRequest(),
						messageOptions,
					) ?? Promise.resolve(null),
			);
			await processor.process(pending, turn.id, assistant, ctx, early);
			this.executedToolRounds = processor.executedRounds;
			notificationsStarted = true;
			await notifications.runPending(turn.id, assistant, ctx);
			this.executedToolRounds = processor.executedRounds;
			turn.status = "completed";
		} catch (err) {
			this.executedToolRounds = processor.executedRounds;
			if (err instanceof AbortError || ctx.signal.aborted) {
				turn.status = "cancelled";
				// Preserve whatever streamed before the interrupt: commit the
				// accumulated partial to the session so the next turn keeps it as
				// context (no-op if nothing streamed yet).
				assistant.finalize();
				bus.emit({ type: "turn:cancelled", turnId: turn.id });
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "cancelled",
					durationMs: turn.durationMs(),
				});
				return "cancelled";
			}
			turn.status = "failed";
			bus.emit({
				type: "run:error",
				error: errorMessage(err),
			});
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status: "failed",
				durationMs: turn.durationMs(),
			});
			return "failed";
		}

		bus.emit({
			type: "turn:end",
			turnId: turn.id,
			status: turn.status,
			durationMs: turn.durationMs(),
		});
		return turn.status;
	}

	private resolveThinking(
		evidence: DynamicThinkingEvidence,
	): ThinkingConfig | null | undefined {
		if (this.deps.thinkingResolver) {
			return this.deps.thinkingResolver.resolve(evidence);
		}
		return evidence.phase === "initial" ? this.deps.thinking : undefined;
	}
}
