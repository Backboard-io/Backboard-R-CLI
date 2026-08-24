import type {
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import type { AgentDefinition } from "../agents/AgentDefinition.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus, UsageInfo } from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import type { HookController } from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type { SpawnedAgent } from "../tools/AgentToolOutput.ts";
import type { Tool } from "../tools/Tool.ts";
import type {
	AskUserFn,
	BackgroundChainState,
	ToolTraceContext,
} from "../tools/ToolContext.ts";

export type SubAgentToolFactory = (opts: {
	depth: number;
	definition: AgentDefinition;
	/** The model the run's turns go to: the definition's override, else the session's. */
	model: ModelRef;
}) => Tool[];

export interface SubAgentRunnerDeps {
	client: AgentClient;
	getModel: () => ModelRef;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	/**
	 * Thinking and tool capability both belong to the model the run's turns
	 * actually go to, which a definition's `model:` overrides — so the resolved
	 * model is passed in rather than read from the session. `signal` must
	 * cancel any lookup, or a run's budget cannot bound it.
	 */
	getThinking: (
		model: ModelRef,
		signal: AbortSignal,
	) => Promise<ThinkingConfig | null | undefined>;
	getThinkingResolver?: (
		model: ModelRef,
		signal: AbortSignal,
	) => Promise<RuntimeThinkingResolver>;
	toolFactory: SubAgentToolFactory;
	isToolEnabled?: (name: string, model: ModelRef) => boolean;
	hookController?: HookController;
	lsp?: LspService;
	checkpoints?: CheckpointRecorder;
}

export interface SubAgentRunParams {
	prompt: string;
	definition: AgentDefinition;
	depth: number;
	/** Per-call override of the definition's budget. */
	timeoutMs?: number;
	parentCwd: string;
	parentSignal: AbortSignal;
	parentBus?: EventBus;
	parentToolCallId?: string;
	/**
	 * The user turn the spawning tool call belongs to. Sub-agent file edits
	 * are journaled under this turn so they fold into the parent checkpoint
	 * (the sub-agent's own turns are never finalized on the main bus).
	 */
	parentTurnId?: string;
	/**
	 * Capture surface from the spawning tool's context. Preferred over
	 * `deps.checkpoints` so nested sub-agents keep the root turn attribution.
	 */
	checkpoints?: CheckpointRecorder;
	parentPermissions?: PermissionContext;
	parentAskUser?: AskUserFn;
	/** This run itself was launched in the background. */
	chainInBackground?: boolean;
	/**
	 * The spawner's chain state, read live: once it is in the background
	 * nobody waits on this run, so its budget stops aborting — even if the
	 * handoff above happens while this run is underway.
	 */
	parentChain?: BackgroundChainState;
	/** Return a handle to background the run; undefined stops and summarizes it. */
	onDeadline?: (handoff: DeadlineHandoff) => { runId: string } | undefined;
	trace?: {
		sessionId: string;
		context: ToolTraceContext;
		clientLogPath: string;
	};
}

export type SubAgentStatus = TurnStatus | "timed_out" | "backgrounded";

export interface DeadlineHandoff {
	continuation: Promise<SubAgentResult>;
	/** Stops it. The only way to end a run once the turn no longer owns it. */
	cancel: () => void;
}

export interface SubAgentResult {
	report: string;
	status: SubAgentStatus;
	usage: UsageInfo;
	toolRounds: number;
	runId?: string;
	logPath?: string;
	children?: SpawnedAgent[];
}
