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
import type { ToolTraceContext } from "../tools/ToolContext.ts";

export type SubAgentToolFactory = (opts: {
	depth: number;
	definition: AgentDefinition;
}) => Tool[];

export interface SubAgentRunnerDeps {
	client: AgentClient;
	getModel: () => ModelRef;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	getThinking: () => Promise<ThinkingConfig | null | undefined>;
	getThinkingResolver?: () => Promise<RuntimeThinkingResolver>;
	toolFactory: SubAgentToolFactory;
	isToolEnabled?: (name: string) => boolean;
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
	/** The spawner is already in the background, so nobody is waiting on this run. */
	parentInBackground?: boolean;
	chainInBackground?: boolean;
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
