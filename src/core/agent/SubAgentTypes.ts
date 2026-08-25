import type {
	MemoryMode,
	MemoryProfile,
	ModelRef,
	ThinkingConfig,
} from "../../config/defaults.ts";
import type { RuntimeThinkingResolver } from "../../config/thinkingRuntime.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus, UsageInfo } from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import type { HookController } from "../hooks/index.ts";
import type { LspService } from "../lsp/index.ts";
import type { PermissionContext } from "../permissions/types.ts";
import type { Tool } from "../tools/Tool.ts";
import type { ToolTraceContext } from "../tools/ToolContext.ts";

export type SubAgentToolFactory = (opts: { depth: number }) => Tool[];

export interface SubAgentRunnerDeps {
	client: AgentClient;
	getModel: () => ModelRef;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	getThinking: () => Promise<ThinkingConfig | null | undefined>;
	getThinkingResolver?: () => Promise<RuntimeThinkingResolver>;
	systemPrompt: string;
	toolFactory: SubAgentToolFactory;
	maxToolRounds?: number;
	isToolEnabled?: (name: string) => boolean;
	hookController?: HookController;
	lsp?: LspService;
	checkpoints?: CheckpointRecorder;
}

export interface SubAgentRunParams {
	prompt: string;
	depth: number;
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
	trace?: {
		sessionId: string;
		context: ToolTraceContext;
		clientLogPath: string;
	};
}

export interface SubAgentResult {
	report: string;
	status: TurnStatus;
	usage: UsageInfo;
	toolRounds: number;
}
