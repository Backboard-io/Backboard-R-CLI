import type { AgentTraceStore } from "../agent/AgentTraceStore.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { AskUserQuestionSpec, TodoItem } from "../bus/events.ts";
import type { CheckpointRecorder } from "../checkpoints/CheckpointStore.ts";
import type { LspService } from "../lsp/index.ts";
import type { PermissionContext } from "../permissions/types.ts";

export type AskUserFn = (
	question: string,
	options: string[],
	signal?: AbortSignal,
) => Promise<string>;

/**
 * Ask several related questions in a single interruption. Returns one answer
 * per question, aligned by index with the input.
 */
export type AskQuestionsFn = (
	questions: AskUserQuestionSpec[],
) => Promise<string[]>;

export interface ToolTraceContext {
	forToolCall(toolCallId: string): ToolTraceContext;
	createAgentTrace(input: {
		mode: "worker" | "rlm";
		prompt: string;
	}): Promise<AgentTraceStore | null>;
}

/**
 * Everything a tool needs to do its job, and nothing more. Passed to every
 * `Tool.execute`. The `signal` aborts in-flight work on turn cancellation; the
 * `askUser` bridge round-trips an interactive question through the UI.
 */
export interface ToolContext {
	sessionId: string;
	turnId?: string;
	toolCallId?: string;
	cwd: string;
	bus: EventBus;
	signal: AbortSignal;
	askUser: AskUserFn;
	/**
	 * Ask a batch of related questions in one prompt. Optional: contexts that
	 * only implement `askUser` still work — callers fall back to asking each
	 * question sequentially.
	 */
	askQuestions?: AskQuestionsFn;
	getTodos?: () => readonly TodoItem[];
	agentDepth?: number;
	/** No foreground turn is waiting on this chain, so budgets below stop enforcing. */
	inBackgroundChain?: boolean;
	trace?: ToolTraceContext;
	/** Optional language-server service for post-edit diagnostics. */
	lsp?: LspService;
	/** Optional pre-image journal powering /undo, /redo and /rewind. */
	checkpoints?: CheckpointRecorder;
	/** Permission state for this session. Absent = permission gate disabled. */
	permissions?: PermissionContext;
}
