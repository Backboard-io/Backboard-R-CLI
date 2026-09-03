import type {
	MemoryProfile,
	ThinkingConfig,
	ThinkingModelMetadata,
} from "../../config/defaults.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import type { BACKBOARD_STREAM_EVENTS } from "./constants.ts";

export type BackboardStatus =
	| "IN_PROGRESS"
	| "REQUIRES_ACTION"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED";

export interface RawToolCall {
	id: string;
	type: "function";
	function: {
		name: string;
		arguments: string;
	};
}

interface BackboardStreamBase {
	[key: string]: unknown;
	type: string;
	thread_id?: string;
	run_id?: string;
}

export interface BackboardUserMessagePayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.userMessage;
}

export interface BackboardContentStreamingPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.contentStreaming;
	content?: string;
	accumulated_content?: string;
}

export interface BackboardToolCallStartPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.toolCallStart;
	tool_call_id?: string;
	name?: string;
}

export interface BackboardToolCallReadyPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.toolCallReady;
	tool_call?: unknown;
}

export interface BackboardToolSubmitRequiredPayload
	extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.toolSubmitRequired;
	tool_calls?: unknown[];
}

export interface BackboardRunEndedPayload extends BackboardStreamBase {
	type:
		| typeof BACKBOARD_STREAM_EVENTS.runEnded
		| typeof BACKBOARD_STREAM_EVENTS.messageComplete;
	status?: string;
	content?: string;
	final_content?: string;
	model_provider?: string;
	model_name?: string;
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	context_usage?: BackboardContextUsage;
}

export interface BackboardContextUsage {
	used_tokens?: number;
	context_limit?: number;
	percent?: number;
	summary_tokens?: number;
	model?: string;
}

export interface BackboardRunFailedPayload extends BackboardStreamBase {
	type:
		| typeof BACKBOARD_STREAM_EVENTS.runFailed
		| typeof BACKBOARD_STREAM_EVENTS.error;
	error?: string;
	message?: string;
}

export interface BackboardRunCancelledPayload extends BackboardStreamBase {
	type: typeof BACKBOARD_STREAM_EVENTS.runCancelled;
}

export type BackboardStreamPayload =
	| BackboardUserMessagePayload
	| BackboardContentStreamingPayload
	| BackboardToolCallStartPayload
	| BackboardToolCallReadyPayload
	| BackboardToolSubmitRequiredPayload
	| BackboardRunEndedPayload
	| BackboardRunFailedPayload
	| BackboardRunCancelledPayload
	| BackboardStreamBase;

export interface SendMessageRequest {
	content: string;
	thread_id?: string;
	assistant_id?: string;
	llm_provider?: string;
	model_name?: string;
	system_prompt?: string;
	memory?: string;
	memory_profile?: MemoryProfile;
	metadata?: Record<string, unknown>;
	thinking?: ThinkingConfig | null;
	tools?: OpenAITool[];
	stream?: boolean;
}

export interface SubmitToolOutputsRequest {
	thread_id: string;
	run_id?: string;
	tool_outputs: Array<{ tool_call_id: string; output: string }>;
	thinking?: ThinkingConfig | null;
	tools?: OpenAITool[];
	stream?: boolean;
}

export interface BackboardResponse {
	thread_id: string;
	content: string | null;
	status: BackboardStatus | null;
	tool_calls: RawToolCall[] | null;
	run_id?: string | null;
	model_provider?: string | null;
	model_name?: string | null;
	input_tokens?: number | null;
	output_tokens?: number | null;
	total_tokens?: number | null;
}

export type BackboardMessageRole = "user" | "assistant" | "tool";

export interface BackboardThreadMessage {
	message_id: string;
	role: BackboardMessageRole;
	content?: string | null;
	metadata_?: Record<string, unknown> | null;
	status?: string | null;
	created_at?: string | null;
	model_provider?: string | null;
	model_name?: string | null;
}

export interface BackboardThread {
	thread_id: string;
	assistant_id?: string | null;
	title?: string | null;
	first_user_message?: string | null;
	message_count?: number | null;
	updated_at?: string | null;
	created_at?: string | null;
	metadata_?: Record<string, unknown> | null;
	messages: BackboardThreadMessage[];
}

/**
 * Provider-neutral turn events. Backboard can yield these from either one JSON
 * response or many SSE payloads without changing the agent loop contract.
 */
export type ProviderEvent =
	| { kind: "thread"; threadId: string }
	| { kind: "assistant_delta"; text: string }
	| { kind: "tool_started"; id: string; name: string }
	| { kind: "tool_ready"; call: ProviderToolCall }
	| {
			kind: "requires_action";
			runId: string | null;
			calls: ProviderToolCall[];
			/** Serialized opaque turn-level provider state needed for continuation. */
			providerMetadata?: string;
	  }
	| { kind: "usage"; usage: ProviderUsage }
	| { kind: "warning"; message: string }
	| {
			kind: "completed";
			finalText?: string;
			usage?: ProviderUsage;
			contextUsage?: BackboardContextUsage;
	  }
	| { kind: "failed"; error: string; retryable?: boolean };

export interface StreamMappingResult {
	events: ProviderEvent[];
	accumulatedContent: string;
}

export interface ContentDeltaResult {
	text: string | null;
	accumulatedContent: string;
}

export interface ProviderToolCall {
	id: string;
	name: string;
	input: unknown;
	/**
	 * Opaque provider token that must be echoed back with the call when the
	 * conversation is replayed. Gemini 3 signs its function calls and rejects a
	 * history whose calls come back unsigned; providers that do not sign leave
	 * this unset.
	 */
	signature?: string;
	/** Provider id that issued `signature`; prevents cross-provider replay. */
	signatureProvider?: string;
}

export interface ProviderUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
	contextTokens?: number;
	contextLimit?: number;
	provider?: string;
	model?: string;
}

/** Which backend serves a model: a saved provider key, or Backboard routing. */
export type ModelSource = "byok" | "backboard";

export interface ModelInfo extends ThinkingModelMetadata {
	id: string;
	provider: string;
	model: string;
	label: string;
	releaseTimestamp?: number;
	source?: ModelSource;
	/** Context window in tokens, when the catalog reports one. */
	contextLimit?: number;
}

export interface ModelCatalogItem {
	name: string;
	display_name?: string;
	provider: string;
	model_type: string;
	last_updated?: string | number | null;
	max_output_tokens?: number | null;
	supports_thinking?: boolean | null;
	thinking_controls?: ThinkingModelMetadata["thinking_controls"];
	source?: ModelSource;
	context_limit?: number | null;
}

export type ModelThinkingMetadataResponse = ThinkingModelMetadata;

export interface ModelsListResponse {
	models: ModelCatalogItem[];
	total: number;
}

export interface ProvidersListResponse {
	providers: string[];
	total: number;
}

export interface AssistantInfo {
	assistant_id: string;
	name: string;
	system_prompt?: string | null;
	tools?: unknown[] | null;
}
