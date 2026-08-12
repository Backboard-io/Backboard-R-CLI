import type { Config } from "../../config/Config.ts";
import { qSessionDir } from "../../config/paths.ts";
import { createRuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import { toPromptProfileId } from "../../prompts/profiles/ids.ts";
import { getSystemPrompt } from "../../prompts/system/index.tsx";
import { TODO_NOT_CALLED_REMINDER } from "../../prompts/todoReminders.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { BackboardError } from "../../providers/backboard/errors.ts";
import { errorMessage } from "../../utils/errors.ts";
import { shortId } from "../../utils/id.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type {
	AskUserQuestionSpec,
	TodoItem,
	TurnStatus,
} from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import {
	AUTO_COMPACT_THRESHOLD_PERCENT,
	buildContextReport,
	CompactionError,
	type CompactionResult,
	Compactor,
	type ContextReport,
	shouldAutoCompact,
} from "../context/index.ts";
import { TERMINAL_HOOK_TIMEOUT_MS } from "../hooks/constants.ts";
import {
	type HookController,
	joinHookContext,
	type UserPromptHookResult,
} from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import {
	nextPermissionMode,
	type PermissionMode,
} from "../permissions/PermissionMode.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type { Message } from "../session/Message.ts";
import { userMessage } from "../session/Message.ts";
import type { Session } from "../session/Session.ts";
import type { SkillController } from "../skills/SkillController.ts";
import { canonicalToolName } from "../tools/names.ts";
import type { OpenAITool } from "../tools/schema.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import type { ToolRegistry } from "../tools/ToolRegistry.ts";
import type { ToolScheduler } from "../tools/ToolScheduler.ts";
import type {
	CancelOptions,
	QueuedSubmit,
	SubmitOptions,
} from "./AgentControllerTypes.ts";
import { AgentLoopFactory } from "./AgentLoopFactory.ts";
import { AgentTraceContext } from "./AgentTraceStore.ts";
import { AssistantSessionBinding } from "./AssistantSessionBinding.ts";
import { Turn } from "./Turn.ts";

export interface AgentControllerDeps {
	config: Config;
	bus: EventBus;
	session: Session;
	registry: ToolRegistry;
	client: AgentClient;
	skillController: SkillController;
	hookController?: HookController;
	assistantBinding?: AssistantSessionBinding;
	syncDynamicTools?: (signal: AbortSignal) => Promise<void>;
	startupEnvironmentPrompt?: string;
	lsp?: LspService;
	checkpoints?: CheckpointRecorder;
	getDurableSession?: () => {
		sessionId: string;
		sessionRoot: string;
		replacesThreadId?: string;
	};
	onThreadReplaced?: (threadId: string | null) => void;
	permissions: PermissionContext;
	/**
	 * Absolute path to this run's client transcript. Named in the handoff so a
	 * compressed agent can read back anything the summary left out.
	 */
	transcriptPath?: string;
	getTranscriptPath?: () => string;
}

/**
 * Public facade the UI talks to. Owns per-turn cancellation, the AskUser bridge
 * between tools and the UI, and the wiring of a fresh AgentLoop per submission.
 */
export class AgentController {
	private abortController: AbortController | null = null;
	private readonly pendingAsks = new Map<string, (answers: string[]) => void>();
	private readonly scheduler: ToolScheduler;
	private readonly loopFactory: AgentLoopFactory;
	private readonly assistantBinding: AssistantSessionBinding;
	private readonly detachSessionProjection: () => void;
	private readonly queue: QueuedSubmit[] = [];
	private drainingQueue = false;
	private sessionHooksStarted = false;

	constructor(private readonly deps: AgentControllerDeps) {
		this.assistantBinding =
			deps.assistantBinding ??
			new AssistantSessionBinding(deps.client, deps.session, deps.config.fresh);
		this.loopFactory = new AgentLoopFactory({
			client: deps.client,
			hookController: deps.hookController,
			assistantResolver: (assistantOptions) =>
				this.assistantBinding.resolve({
					systemPrompt: assistantOptions.systemPrompt,
					tools: assistantOptions.tools,
					signal: assistantOptions.signal,
				}),
		});
		this.scheduler = this.loopFactory.createScheduler({
			registry: deps.registry,
			bus: deps.bus,
			isToolEnabled: (name) => deps.config.isToolEnabled(name),
		});
		this.detachSessionProjection = deps.session.attach(deps.bus);
	}

	get isRunning(): boolean {
		return this.abortController !== null;
	}

	get hasActiveWork(): boolean {
		return (
			this.abortController !== null ||
			this.drainingQueue ||
			this.queue.length > 0
		);
	}

	get permissionMode(): PermissionMode {
		return this.deps.permissions.mode;
	}

	/** Shift+Tab: advance the mode and notify the UI. */
	cyclePermissionMode(): PermissionMode {
		const next = nextPermissionMode(this.deps.permissions.mode);
		this.deps.permissions.mode = next;
		this.deps.bus.emit({ type: "permission:mode", mode: next });
		return next;
	}

	get threadId(): string | null {
		return this.deps.session.threadId;
	}

	listToolNames(): string[] {
		return this.deps.registry.list().map((tool) => tool.name);
	}

	enableComputerUse(): void {
		this.deps.config.enableComputerUse();
	}

	setComputerUseEnabled(enabled: boolean): void {
		this.deps.config.setComputerUseEnabled(enabled);
	}

	get isComputerUseEnabled(): boolean {
		return this.deps.config.isComputerUseEnabled;
	}

	setSkillDiscoveryEnabled(enabled: boolean): void {
		this.deps.config.setSkillDiscoveryEnabled(enabled);
	}

	get isSkillDiscoveryEnabled(): boolean {
		return this.deps.config.isSkillDiscoveryEnabled;
	}

	enableBrowserUse(): void {
		this.deps.config.enableBrowserUse();
	}

	setBrowserUseEnabled(enabled: boolean): void {
		this.deps.config.setBrowserUseEnabled(enabled);
	}

	get isBrowserUseEnabled(): boolean {
		return this.deps.config.isBrowserUseEnabled;
	}

	hydrateSession(input: {
		threadId: string;
		assistantId?: string | null;
		messages: readonly Message[];
	}): void {
		this.deps.session.hydrate(input);
	}

	async dispose(): Promise<void> {
		// Pair SessionEnd with SessionStart: only fire it if the session started.
		if (this.sessionHooksStarted) {
			await this.runTerminalHook((signal) =>
				this.deps.hookController?.runSessionEnd("exit", signal),
			);
		}
		await this.disposeTools();
		this.detachSessionProjection();
	}

	async submit(text: string, options: SubmitOptions = {}): Promise<TurnStatus> {
		return this.enqueueSubmit(text, "back", {
			emitUserMessage: options.emitUserMessage ?? true,
			onStart: options.onStart,
			attachmentFilePaths: options.attachmentFilePaths,
			displayContent: options.displayContent,
		});
	}

	async steer(text: string, options: SubmitOptions = {}): Promise<TurnStatus> {
		const shouldCancelActiveTurn = this.abortController !== null;
		const run = this.enqueueSubmit(text, "front", {
			emitUserMessage: options.emitUserMessage ?? false,
			onStart: options.onStart,
			attachmentFilePaths: options.attachmentFilePaths,
			displayContent: options.displayContent,
		});
		if (shouldCancelActiveTurn) this.cancel();
		return run;
	}

	private enqueueSubmit(
		text: string,
		placement: "front" | "back",
		options: Required<Pick<SubmitOptions, "emitUserMessage">> &
			Pick<SubmitOptions, "onStart" | "attachmentFilePaths" | "displayContent">,
	): Promise<TurnStatus> {
		const run = new Promise<TurnStatus>((resolve, reject) => {
			const queued = {
				text,
				emitUserMessage: options.emitUserMessage,
				onStart: options.onStart,
				attachmentFilePaths: options.attachmentFilePaths,
				displayContent: options.displayContent,
				resolve,
				reject,
			};
			if (placement === "front") {
				this.queue.unshift(queued);
			} else {
				this.queue.push(queued);
			}
		});
		void this.drainSubmitQueue();
		return run;
	}

	private async drainSubmitQueue(): Promise<void> {
		if (this.drainingQueue) return;
		this.drainingQueue = true;
		try {
			while (this.queue.length > 0) {
				const queued = this.queue.shift();
				if (!queued) continue;
				try {
					queued.onStart?.();
					queued.resolve(
						await this.runTurn(queued.text, {
							emitUserMessage: queued.emitUserMessage,
							attachmentFilePaths: queued.attachmentFilePaths,
							displayContent: queued.displayContent,
						}),
					);
				} catch (err) {
					queued.reject(err);
				}
			}
		} finally {
			this.drainingQueue = false;
			if (this.queue.length > 0) void this.drainSubmitQueue();
		}
	}

	private async runTurn(
		text: string,
		options: {
			emitUserMessage: boolean;
			attachmentFilePaths?: string[];
			displayContent?: string;
		},
	): Promise<TurnStatus> {
		const { bus, session, config } = this.deps;
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const turn = new Turn();
		let turnStarted = false;
		let finalStatus: TurnStatus = "failed";

		try {
			const hookController = this.deps.hookController;

			bus.emit({ type: "turn:start", turnId: turn.id });
			const turnStartTodos = [...session.todos];

			let promptHook: UserPromptHookResult | undefined;
			if (hookController?.hasTrustedUserPromptHooks()) {
				promptHook = await this.runUserPromptHooks(turn.id, text, signal);
			}
			if (promptHook?.blockedReason) {
				bus.emit({
					type: "system:warning",
					message: `Prompt blocked by hook: ${promptHook.blockedReason}`,
				});
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "failed",
					durationMs: turn.durationMs(),
				});
				return "failed";
			}

			if (options.emitUserMessage) bus.emit({ type: "user:message", text });
			session.addMessage(userMessage(text));
			turnStarted = true;

			const ctx = this.buildContext(signal, turnStartTodos);
			// All four are independent of each other: assistant resolution and
			// thinking metadata are network round-trips, the skill scan reads
			// only the skill catalog + filesystem, and the tool sync talks to
			// MCP servers - none may stall the others. The only ordering that
			// matters is that syncDynamicTools completes before
			// visibleSchemas() below, which the single Promise.all preserves.
			// An existing thread already knows its assistant, so skip the
			// resolution round-trip entirely.
			const [, skillPromptContext, assistantId, thinkingResolver] =
				await Promise.all([
					this.deps.syncDynamicTools?.(signal),
					this.deps.skillController.buildPromptContext(text),
					// A key-backed model has no assistant record to resolve, and an
					// existing thread already knows its assistant - either way the
					// round-trip is skipped.
					!this.deps.client.capabilities.assistants || session.threadId
						? (session.assistantId ?? undefined)
						: this.loopFactory.resolveAssistantId({
								systemPrompt: this.baseSystemPrompt(),
								tools: this.baseTools(),
								signal,
							}),
					createRuntimeThinkingResolver(config, this.deps.client),
				]);
			const promptProfile = toPromptProfileId(config.modelProfile.name);
			const tools = config.toolPolicy.visibleSchemas(
				this.deps.registry,
				[],
				promptProfile,
			);
			const enabledTools = tools.map((tool) => tool.function.name);
			const todoWriteAvailable = enabledTools.some(
				(name) => canonicalToolName(name) === "todo_write",
			);
			// Re-invoked for injected notification requests, so the reminder
			// disappears as soon as TodoWrite runs mid-turn.
			const buildTurnSystemPrompt = () =>
				getSystemPrompt({
					layout: config.modelProfile.systemPromptLayout,
					profile: promptProfile,
					enabledTools,
					...skillPromptContext,
					computerUseEnabled: config.isComputerUseEnabled,
					browserUseEnabled: config.isBrowserUseEnabled,
					skillDiscoveryEnabled: config.isSkillDiscoveryEnabled,
					startupEnvironmentPrompt: this.deps.startupEnvironmentPrompt,
					hookContext: joinHookContext(
						this.deps.hookController?.baseContext,
						promptHook?.additionalContext,
					),
					todoReminderPrompt:
						todoWriteAvailable && !session.hasUsedTodoWrite
							? TODO_NOT_CALLED_REMINDER
							: undefined,
				});
			const systemPrompt = buildTurnSystemPrompt();
			const loop = this.loopFactory.createLoop({
				scheduler: this.scheduler,
				session,
				bus,
				tools,
				systemPrompt,
				refreshSystemPrompt: buildTurnSystemPrompt,
				assistantId,
				model: config.model,
				memory: config.memory,
				memoryProfile: config.memoryProfile,
				workspaceId:
					config.memory === "off" ? undefined : config.getWorkspaceId(),
				thinking: undefined,
				thinkingResolver,
				requestKind: "user",
				finalVerificationNudge: config.finalVerificationNudge,
				turnId: turn.id,
				turnStartedAt: turn.startedAt,
				turnAlreadyStarted: true,
				attachmentFilePaths: options.attachmentFilePaths?.length
					? options.attachmentFilePaths
					: undefined,
				displayContent: options.displayContent,
				durableSession: this.deps.getDurableSession?.(),
			});

			finalStatus = await loop.run(text, ctx);
			return finalStatus;
		} catch (err) {
			if (signal.aborted) {
				finalStatus = "cancelled";
				bus.emit({ type: "turn:cancelled", turnId: turn.id });
				bus.emit({
					type: "turn:end",
					turnId: turn.id,
					status: "cancelled",
					durationMs: turn.durationMs(),
				});
				return finalStatus;
			}
			finalStatus = "failed";
			bus.emit({
				type: "run:error",
				error: formatSubmitError(err),
			});
			bus.emit({
				type: "turn:end",
				turnId: turn.id,
				status: "failed",
				durationMs: turn.durationMs(),
			});
			return finalStatus;
		} finally {
			// Stop runs for every turn that actually started, whatever the outcome.
			if (turnStarted) await this.runStopHooks(turn.id, finalStatus);
			await this.disposeTools();
			this.abortController = null;
			this.rejectPendingAsks();
		}
	}

	private async runUserPromptHooks(
		turnId: string,
		text: string,
		signal: AbortSignal,
	): Promise<UserPromptHookResult> {
		const hookController = this.deps.hookController;
		if (!hookController) return {};
		return await hookController.runUserPromptSubmit({
			turnId,
			prompt: text,
			signal,
		});
	}

	private async runStopHooks(
		turnId: string,
		status: TurnStatus,
	): Promise<void> {
		// Always bound Stop like SessionEnd so a slow hook can't block teardown.
		await this.runTerminalHook((signal) =>
			this.deps.hookController?.runStop({ turnId, status, signal }),
		);
	}

	private async runTerminalHook(
		run: (signal: AbortSignal) => Promise<void> | undefined,
	): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			TERMINAL_HOOK_TIMEOUT_MS,
		);
		try {
			await run(controller.signal);
		} catch {
			// Terminal hooks are best-effort.
		} finally {
			clearTimeout(timer);
		}
	}

	/** Runs SessionStart once at init; SessionEnd is paired in dispose(). */
	async start(): Promise<void> {
		if (this.sessionHooksStarted) return;
		this.sessionHooksStarted = true;
		const hookController = this.deps.hookController;
		if (!hookController) return;
		const controller = new AbortController();
		try {
			await hookController.runSessionStart("startup", controller.signal);
		} catch {
			// Best-effort; never block startup on a hook failure.
		}
	}

	/**
	 * Seeds the context window from the catalog entry the user just picked, so
	 * `/context` is right immediately rather than after the first turn.
	 */
	setModelContextLimit(limit: number | null): void {
		this.deps.session.setContextLimit(limit);
	}

	/**
	 * Snapshot of what is filling the context window, for `/context`. Reads the
	 * same prompt and tool schemas a turn would send, so the breakdown reflects
	 * the real request rather than an idealized one.
	 */
	contextReport(source = "backboard"): ContextReport {
		const { config, session } = this.deps;
		return buildContextReport({
			model: config.model,
			source,
			systemPrompt: this.baseSystemPrompt(),
			tools: this.baseTools(),
			messages: session.getMessages(),
			todos: session.todos,
			usedTokens: session.contextTokens,
			reportedLimit: session.reportedContextLimit,
			cachedTokens: session.cachedTokens,
			compactThresholdPercent: AUTO_COMPACT_THRESHOLD_PERCENT,
		});
	}

	/**
	 * True once the last measured turn crossed the auto-compression threshold.
	 * The UI checks this after a turn ends, never during one.
	 */
	needsCompaction(): boolean {
		const report = this.contextReport();
		return shouldAutoCompact({
			usedTokens: report.measured ? report.usedTokens : 0,
			limit: report.limit,
			messageCount: report.messageCount,
		});
	}

	get canCompact(): boolean {
		return new Compactor({
			client: this.deps.client,
			session: this.deps.session,
			config: this.deps.config,
		}).canCompact();
	}

	/**
	 * Compresses the conversation and restarts the thread from a handoff
	 * document. Returns the context the caller must carry into the next turn.
	 */
	async compact(signal?: AbortSignal): Promise<CompactionResult> {
		if (this.abortController) {
			throw new CompactionError(
				"Finish or cancel the current turn before compressing.",
			);
		}
		const transcriptPath =
			this.deps.getTranscriptPath?.() ?? this.deps.transcriptPath;
		const compactor = new Compactor({
			client: this.deps.client,
			session: this.deps.session,
			config: this.deps.config,
			bus: this.deps.bus,
			...(transcriptPath ? { transcriptPath } : {}),
		});
		const replacedThreadId = this.deps.session.threadId;
		const result = await compactor.compact(
			signal === undefined ? {} : { signal },
		);
		const replacedSource = replacedThreadId
			? this.deps.client.sourceForThread?.(replacedThreadId)
			: undefined;
		this.deps.onThreadReplaced?.(
			replacedThreadId &&
				(replacedSource === undefined || replacedSource === "byok")
				? replacedThreadId
				: null,
		);
		// The thread was reset, so the assistant binding for the old thread is
		// stale too; a new one is resolved on the next turn.
		this.deps.session.assistantId = null;
		return result;
	}

	private baseSystemPrompt(): string {
		const enabledTools = this.baseTools().map((tool) => tool.function.name);
		return getSystemPrompt({
			enabledTools,
			startupEnvironmentPrompt: this.deps.startupEnvironmentPrompt,
		});
	}

	private baseTools(): OpenAITool[] {
		return this.deps.config.toolPolicy.visibleSchemas(
			this.deps.registry,
			this.baseToolSchemaExcludedNames(),
		);
	}

	private baseToolSchemaExcludedNames(): string[] {
		const excluded = new Set(this.deps.config.toolSchemaExcludedNames);
		excluded.add("browser");
		excluded.add("computer");
		for (const tool of this.deps.registry.list()) {
			if (tool.agentName.startsWith("mcp__")) excluded.add(tool.agentName);
		}
		return [...excluded];
	}

	/** Cancels the active turn, aborting in-flight requests and tools. */
	cancel(options: CancelOptions = {}): void {
		this.abortController?.abort();
		this.rejectPendingAsks();
		if (options.clearQueue) this.clearQueuedSubmits();
	}

	/** Cancels any active turn and starts a fresh Backboard thread. */
	newThread(): void {
		this.cancel({ clearQueue: true });
		this.deps.session.reset();
	}

	/** Resolves a pending AskUser request raised by a tool. */
	provideInput(id: string, answers: string[]): void {
		const resolve = this.pendingAsks.get(id);
		if (resolve) {
			this.pendingAsks.delete(id);
			this.deps.bus.emit({ type: "input:response", response: { id, answers } });
			resolve(answers);
		}
	}

	private buildContext(
		signal: AbortSignal,
		turnStartTodos: readonly TodoItem[],
	): ToolContext {
		const durable = this.deps.getDurableSession?.();
		return {
			sessionId: durable?.sessionId ?? this.deps.session.sessionId,
			cwd: this.deps.config.cwd,
			bus: this.deps.bus,
			signal,
			askUser: (question, options, promptSignal) =>
				this.askQuestions([{ question, options }], promptSignal ?? signal).then(
					(answers) => answers[0] ?? "",
				),
			askQuestions: (questions) => this.askQuestions(questions, signal),
			getTodos: () => this.deps.session.todos,
			getTurnStartTodos: () => turnStartTodos,
			agentDepth: 0,
			lsp: this.deps.lsp,
			checkpoints: this.deps.checkpoints,
			permissions: this.deps.permissions,
			trace: new AgentTraceContext({
				sessionId: durable?.sessionId ?? this.deps.session.sessionId,
				sessionRoot:
					durable?.sessionRoot ??
					qSessionDir(this.deps.config.cwd, this.deps.session.sessionId),
				cwd: this.deps.config.cwd,
			}),
		};
	}

	private clearQueuedSubmits(): void {
		const queued = this.queue.splice(0);
		for (const submit of queued) {
			submit.resolve("cancelled");
		}
	}

	private askQuestions(
		questions: AskUserQuestionSpec[],
		signal: AbortSignal,
	): Promise<string[]> {
		if (signal.aborted) return Promise.reject(new Error("aborted"));
		const id = shortId("ask");
		this.deps.bus.emit({
			type: "input:request",
			request: { id, questions },
		});

		return new Promise<string[]>((resolve, reject) => {
			this.pendingAsks.set(id, resolve);
			signal.addEventListener(
				"abort",
				() => {
					if (this.pendingAsks.delete(id)) {
						this.deps.bus.emit({
							type: "input:response",
							response: { id, answers: [] },
						});
						reject(new Error("aborted"));
					}
				},
				{ once: true },
			);
		});
	}

	private rejectPendingAsks(): void {
		this.pendingAsks.clear();
	}

	private async disposeTools(): Promise<void> {
		for (const tool of this.deps.registry.list()) {
			try {
				await tool.dispose();
			} catch (err) {
				this.deps.bus.emit({
					type: "run:error",
					error: `Tool cleanup failed for ${tool.name}: ${formatSubmitError(err)}`,
				});
			}
		}
	}
}

function formatSubmitError(err: unknown): string {
	if (err instanceof BackboardError) {
		return `${err.message}: ${JSON.stringify(err.body)}`;
	}
	return errorMessage(err);
}
