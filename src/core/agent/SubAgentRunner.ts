import type { ModelRef, ThinkingConfig } from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import { shortId } from "../../utils/id.ts";
import { EventBus } from "../bus/EventBus.ts";
import { revocableRecorder } from "../checkpoints/CheckpointStore.ts";
import { emptyRuleSet } from "../permissions/PermissionRules.ts";
import { ClientEventLog } from "../session/ClientEventLog.ts";
import { Session } from "../session/Session.ts";
import type { SpawnedAgent } from "../tools/AgentToolOutput.ts";
import type {
	BackgroundChainState,
	ToolContext,
} from "../tools/ToolContext.ts";
import { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { AgentLoop } from "./AgentLoop.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import { RunBudget } from "./RunBudget.ts";
import {
	HANDED_OFF_REPORT,
	MAX_SUBAGENT_TOOL_ROUNDS,
	SUBAGENT_TIMEOUT_SUMMARY_MS,
	subAgentSystemPrompt,
	TIMED_OUT_WITHOUT_REPORT,
	timeoutSummaryPrompt,
} from "./SubAgentConstants.ts";
import type {
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
} from "./SubAgentTypes.ts";

export type {
	DeadlineHandoff,
	SubAgentResult,
	SubAgentRunnerDeps,
	SubAgentRunParams,
	SubAgentStatus,
	SubAgentToolFactory,
} from "./SubAgentTypes.ts";

/**
 * Drives one isolated sub-agent to completion and returns only its distilled
 * report. The sub-agent gets its own Session, EventBus, tool registry, and
 * Backboard thread, so its intermediate tool churn never enters the parent's
 * context. This context isolation is the core property that lets a long coding
 * session delegate work without suffering context rot.
 */
export class SubAgentRunner {
	constructor(private readonly deps: SubAgentRunnerDeps) {}

	async run(params: SubAgentRunParams): Promise<SubAgentResult> {
		const bus = new EventBus();
		const session = new Session(shortId("subagent"));
		const detachSessionProjection = session.attach(bus);
		const childLog = params.trace
			? new ClientEventLog(params.trace.sessionId, params.trace.clientLogPath)
			: null;
		childLog?.attach(bus);
		if (params.trace) {
			bus.emit({
				type: "session:created",
				sessionId: session.sessionId,
				threadId: session.threadId,
			});
		}
		const detachParentProgress = this.attachParentProgressRelay(params, bus);

		// Every Agent result on this private bus is a sub-agent this run spawned.
		const spawned: SpawnedAgent[] = [];
		bus.on("tool:result", (event) => {
			const output = event.agentOutput;
			if (!output) return;
			spawned.push({
				agent: output.agent ?? "agent",
				status: output.status,
				rounds: output.rounds,
				...(output.runId ? { runId: output.runId } : {}),
				...(output.children?.length ? { children: output.children } : {}),
			});
		});

		const reports: string[] = [];
		bus.on("assistant:message", (event) => {
			const text = event.text.trim();
			if (text) reports.push(text);
		});

		const model = params.definition.model ?? this.deps.getModel();

		const tools = this.deps.toolFactory({
			depth: params.depth,
			definition: params.definition,
			model,
		});
		const registry = new ToolRegistry(tools);
		const toolSchemas = registry.toJSONSchemas();
		const loopFactory = new AgentLoopFactory({
			client: this.deps.client,
			hookController: this.deps.hookController,
		});
		const scheduler = loopFactory.createScheduler({
			registry,
			bus,
			isToolEnabled: (name) => this.deps.isToolEnabled?.(name, model) ?? true,
		});

		// The sub-agent's turns live on this private bus, so the shared
		// CheckpointStore never sees their turn:end and would never finalize a
		// checkpoint journaled under them. Scope captures to the spawning user
		// turn instead: sub-agent edits fold into the parent's (finalized)
		// checkpoint and stay visible to /undo and /rewind. Without a parent
		// turn to attribute to, capture is disabled rather than journaling
		// entries no checkpoint could ever surface.
		const parentRecorder = params.checkpoints ?? this.deps.checkpoints;
		const scoped = params.parentTurnId
			? parentRecorder?.scopedToTurn(params.parentTurnId)
			: undefined;
		const revocable = scoped ? revocableRecorder(scoped) : undefined;
		const checkpoints = revocable?.recorder;

		// A budget bounds how long someone waits. With a handoff, or once the
		// chain above is backgrounded, nobody is: expiry must not abort. The
		// chain is consulted when the deadline fires, since the parent may have
		// been handed off while this run was underway. Started before the
		// model-metadata preflight below, which is a network round-trip: a
		// lookup that stalls must still reach the deadline, or a call with a
		// timeout would sit in the foreground without ever timing out or
		// handing off.
		const canHandOff = params.onDeadline !== undefined;
		const parentChain = params.parentChain;
		const budget = RunBudget.start(
			params.parentSignal,
			params.timeoutMs ?? params.definition.timeoutMs,
			{
				abortOnExpiry: () => !canHandOff && parentChain?.inBackground !== true,
			},
		);

		// Read through every context copy the tool rounds make, so a handoff
		// anywhere up the chain changes what descendants see from then on.
		// Closes over locals, not `params`, so the chain link a descendant keeps
		// does not pin this run's prompt and permissions.
		let handedOff = false;
		const launchedInBackground = params.chainInBackground === true;
		const backgroundChain: BackgroundChainState = {
			get inBackground() {
				return (
					launchedInBackground ||
					handedOff ||
					parentChain?.inBackground === true
				);
			},
		};

		const ctx: ToolContext = {
			sessionId: session.sessionId,
			cwd: params.parentCwd,
			bus,
			signal: budget.signal,
			// A sub-agent can never prompt the human, so AskUser is unavailable.
			askUser: async () => {
				throw new Error("A sub-agent cannot ask the user a question.");
			},
			getTodos: () => session.todos,
			agentDepth: params.depth,
			backgroundChain,
			trace: params.trace?.context,
			lsp: this.deps.lsp,
			checkpoints,
			// interactive:false so a sub-agent "ask" auto-denies. Fall back to a
			// locked-down context (not undefined) so a missing parent can't
			// disable the gate.
			permissions: params.parentPermissions
				? { ...params.parentPermissions, interactive: false }
				: { mode: "manual", rules: emptyRuleSet(), interactive: false },
		};

		// Built inside `settle` so the deadline race below is already armed
		// while the preflight runs; nothing outside may assume it exists yet.
		let loop: AgentLoop | undefined;

		const settle = (async (): Promise<SubAgentResult> => {
			try {
				const { thinking, thinkingResolver } = await this.preflight(
					model,
					budget.signal,
				);
				// Aborted before any turn ran: nothing to run and nothing a
				// summary turn could salvage.
				if (budget.signal.aborted) {
					return {
						report: budget.timedOut
							? TIMED_OUT_WITHOUT_REPORT
							: "(the sub-agent produced no output)",
						status: budget.timedOut ? "timed_out" : "cancelled",
						usage: session.usage,
						toolRounds: 0,
					};
				}
				loop = loopFactory.createLoop({
					scheduler,
					session,
					bus,
					tools: toolSchemas,
					systemPrompt: subAgentSystemPrompt(params.definition.systemPrompt),
					model,
					memory: this.deps.memory,
					memoryProfile: this.deps.memoryProfile,
					thinking,
					thinkingResolver,
					requestKind: "subagent",
					maxToolRounds:
						params.definition.maxRounds ?? MAX_SUBAGENT_TOOL_ROUNDS,
				});
				const status = await loop.run(params.prompt.trim(), ctx);

				// The deadline aborted the turn; salvage what it established.
				if (status === "cancelled" && budget.timedOut && !handedOff) {
					await this.summarizeAfterTimeout({
						loopFactory,
						session,
						bus,
						ctx,
						params,
						model,
						thinking,
						thinkingResolver,
					});
					return {
						report: reports.at(-1) ?? TIMED_OUT_WITHOUT_REPORT,
						status: "timed_out",
						usage: session.usage,
						toolRounds: loop.toolRounds,
						...(spawned.length ? { children: [...spawned] } : {}),
					};
				}

				return {
					report: reports.at(-1) ?? "(the sub-agent produced no output)",
					status,
					usage: session.usage,
					toolRounds: loop.toolRounds,
					...(spawned.length ? { children: [...spawned] } : {}),
				};
			} finally {
				budget.dispose();
				detachParentProgress();
				detachSessionProjection();
				await childLog?.flush();
			}
		})();

		if (!canHandOff) return settle;

		// Whichever comes first: the run finishing, or its budget running out.
		const outcome = await Promise.race([
			settle.then((result) => ({ kind: "settled" as const, result })),
			budget.expiry.then(() => ({ kind: "expired" as const })),
		]);
		if (outcome.kind === "settled") return outcome.result;

		const handle = params.onDeadline?.({
			continuation: settle,
			cancel: () => budget.cancel(),
		});
		if (!handle) {
			// Nowhere to hand it off to, so enforce the budget after all.
			budget.abortForTimeout();
			return settle;
		}

		// The turn no longer owns this run, so its cancellation must not reach
		// it, and its progress must stop touching a tool row that is now closed.
		// Also moves `backgroundChain` to the background, so budgets stop being
		// enforced for anything the run spawns from here on.
		handedOff = true;
		budget.detachFromParent();
		detachParentProgress();
		await revocable?.revoke();
		return {
			report: HANDED_OFF_REPORT,
			status: "backgrounded",
			usage: session.usage,
			toolRounds: loop?.toolRounds ?? 0,
			runId: handle.runId,
			...(params.trace ? { logPath: params.trace.clientLogPath } : {}),
			...(spawned.length ? { children: [...spawned] } : {}),
		};
	}

	/**
	 * Resolves the model's thinking configuration. `signal` cancels the
	 * metadata request: an enforced deadline must not be held open by it, and
	 * the run it belongs to is about to be cancelled anyway.
	 */
	private async preflight(
		model: ModelRef,
		signal: AbortSignal,
	): Promise<{
		thinking: ThinkingConfig | null | undefined;
		thinkingResolver: RuntimeThinkingResolver | undefined;
	}> {
		const thinkingResolver = this.deps.getThinkingResolver
			? await this.deps.getThinkingResolver(model, signal)
			: undefined;
		const thinking = thinkingResolver
			? undefined
			: await this.deps.getThinking(model, signal);
		return { thinking, thinkingResolver };
	}

	/** One tool-less turn on the run's own session. Best-effort. */
	private async summarizeAfterTimeout(input: {
		loopFactory: AgentLoopFactory;
		session: Session;
		bus: EventBus;
		ctx: ToolContext;
		params: SubAgentRunParams;
		model: ModelRef;
		thinking: ThinkingConfig | null | undefined;
		thinkingResolver: RuntimeThinkingResolver | undefined;
	}): Promise<void> {
		const signal = AbortSignal.any([
			input.params.parentSignal,
			AbortSignal.timeout(SUBAGENT_TIMEOUT_SUMMARY_MS),
		]);
		if (signal.aborted) return;

		const registry = new ToolRegistry([]);
		const summaryLoop = input.loopFactory.createLoop({
			scheduler: input.loopFactory.createScheduler({
				registry,
				bus: input.bus,
			}),
			session: input.session,
			bus: input.bus,
			tools: [],
			systemPrompt: subAgentSystemPrompt(input.params.definition.systemPrompt),
			model: input.model,
			memory: this.deps.memory,
			memoryProfile: this.deps.memoryProfile,
			thinking: input.thinking,
			thinkingResolver: input.thinkingResolver,
			requestKind: "subagent",
			maxToolRounds: 0,
		});

		try {
			await summaryLoop.run(timeoutSummaryPrompt(input.params.definition), {
				...input.ctx,
				signal,
			});
		} catch {
			// Keep whatever streamed before the budget expired.
		}
	}

	private attachParentProgressRelay(
		params: SubAgentRunParams,
		bus: EventBus,
	): () => void {
		if (!params.parentBus || !params.parentToolCallId) return () => {};
		// The bus is synchronous, so once the parent cancels, a winding-down
		// child's events must not reach the parent - they would resurrect the
		// parent's already-committed "Interrupted" row.
		const detachStart = bus.on("tool:start", (event) => {
			if (params.parentSignal.aborted) return;
			params.parentBus?.emit({
				type: "agent:child_tool_start",
				agentToolCallId: params.parentToolCallId ?? "",
				call: {
					id: event.toolCallId,
					name: event.name,
					inputSummary: event.inputSummary,
					status: "running",
				},
			});
		});
		const detachResult = bus.on("tool:result", (event) => {
			if (params.parentSignal.aborted) return;
			params.parentBus?.emit({
				type: "agent:child_tool_result",
				agentToolCallId: params.parentToolCallId ?? "",
				childToolCallId: event.toolCallId,
				status: "done",
			});
		});
		const detachError = bus.on("tool:error", (event) => {
			if (params.parentSignal.aborted) return;
			params.parentBus?.emit({
				type: "agent:child_tool_result",
				agentToolCallId: params.parentToolCallId ?? "",
				childToolCallId: event.toolCallId,
				status: "error",
			});
		});
		return () => {
			detachStart();
			detachResult();
			detachError();
		};
	}
}
