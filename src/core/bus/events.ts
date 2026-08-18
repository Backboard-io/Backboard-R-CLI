import type { PermissionMode } from "../permissions/PermissionMode.ts";
import type { AgentToolOutput } from "../tools/AgentToolOutput.ts";
import type { ToolResultDetailLine } from "../tools/ToolResultDetail.ts";

export type TurnStatus =
	| "in_progress"
	| "requires_action"
	| "completed"
	| "failed"
	| "cancelled";

export interface BackgroundRunSnapshot {
	id: string;
	agent: string;
	label: string;
	status: "running" | TurnStatus | "timed_out" | "backgrounded";
	adopted?: boolean;
	startedAt: number;
	finishedAt?: number;
	rounds: number;
}

export interface ToolCallRef {
	id: string;
	name: string;
	input: unknown;
}

interface ToolPendingEvent {
	type: "tool:pending";
	toolCallId: string;
	name: string;
	inputSummary: string;
}

interface ToolStartEvent {
	type: "tool:start";
	toolCallId: string;
	name: string;
	inputSummary: string;
	agentMode?: "worker" | "rlm";
}

interface ToolResultEvent {
	type: "tool:result";
	toolCallId: string;
	name: string;
	title: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	agentOutput?: AgentToolOutput;
}

export interface AgentChildToolCall {
	id: string;
	name: string;
	inputSummary: string;
	status: "running" | "done" | "error";
}

export interface UsageInfo {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	contextTokens?: number;
	contextLimit?: number;
	model?: string;
	provider?: string;
}

export interface TodoItem {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed";
}

export interface AskUserQuestionSpec {
	/** Short title shown in the breadcrumb at the top of the prompt. */
	header?: string;
	question: string;
	options: string[];
}

export interface AskUserRequest {
	id: string;
	questions: AskUserQuestionSpec[];
}

export interface AskUserResponse {
	id: string;
	/** One answer per question, aligned by index with `request.questions`. */
	answers: string[];
}

/**
 * The single source of truth for everything that happens in a run. The agent
 * loop and scheduler publish these; the UI and the client event log are pure
 * subscribers. Adding a new event means adding a member here and nothing else
 * structurally changes.
 */
export type AgentEvent =
	| { type: "session:created"; sessionId: string; threadId: string | null }
	| { type: "user:message"; text: string }
	| { type: "turn:start"; turnId: string }
	| { type: "assistant:delta"; turnId: string; messageId: string; text: string }
	| {
			type: "assistant:message";
			turnId: string;
			messageId: string;
			text: string;
	  }
	| { type: "assistant:message:discard"; turnId: string; messageId: string }
	| { type: "tool:requested"; turnId: string; calls: ToolCallRef[] }
	| ToolPendingEvent
	// A previously announced (tool:pending) call that will never execute:
	// its stream attempt was retried, or the authoritative call list never
	// confirmed it. Subscribers should drop the row.
	| { type: "tool:retracted"; toolCallId: string }
	| ToolStartEvent
	| { type: "tool:progress"; toolCallId: string; data: unknown }
	| {
			type: "agent:child_tool_start";
			agentToolCallId: string;
			call: AgentChildToolCall;
	  }
	| {
			type: "agent:child_tool_result";
			agentToolCallId: string;
			childToolCallId: string;
			status: "done" | "error";
	  }
	| ToolResultEvent
	| { type: "agent:background_started"; run: BackgroundRunSnapshot }
	| { type: "agent:background_finished"; run: BackgroundRunSnapshot }
	| { type: "tool:error"; toolCallId: string; name: string; error: string }
	| {
			type: "turn:end";
			turnId: string;
			status: TurnStatus;
			durationMs: number;
	  }
	| { type: "turn:cancelled"; turnId: string }
	| {
			type: "checkpoint:restored";
			checkpointId: string;
			files: number;
			skipped: number;
	  }
	| { type: "input:request"; request: AskUserRequest }
	| { type: "input:response"; response: AskUserResponse }
	| { type: "permission:mode"; mode: PermissionMode }
	| { type: "todos:updated"; todos: TodoItem[] }
	| { type: "usage"; usage: UsageInfo }
	| { type: "system:warning"; message: string }
	| { type: "run:error"; error: string };

export type AgentEventType = AgentEvent["type"];
