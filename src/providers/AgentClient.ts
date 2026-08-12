import type { OpenAITool } from "../core/tools/schema.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "./backboard/types.ts";

export interface RequestOptions {
	signal?: AbortSignal;
}

export interface RunMessageOptions extends RequestOptions {
	/** Local files sent inline with the message. */
	attachmentFilePaths?: string[];
	/** User-authored text shown on resume when wire content includes reminders. */
	displayContent?: string;
	/**
	 * Marks a top-level user conversation as durable. Helper requests omit this
	 * so sub-agent, compaction, and RLM threads never appear in `/sessions`.
	 */
	durableSession?: {
		sessionId: string;
		sessionRoot: string;
		/** Explicit ownership transfer after compaction replaces a thread. */
		replacesThreadId?: string;
	};
}

/**
 * What a turn engine may ask of a model backend. Declaring these capabilities
 * up front is what lets one `AgentLoop` drive both Backboard (server-held
 * threads, assistants, and memory) and a direct vendor key (none of those)
 * without either path special-casing the other.
 */
export interface AgentClientCapabilities {
	/** Server-side assistant records must be resolved before a turn. */
	assistants: boolean;
	/** Threads are server-held and can be listed/resumed. */
	threads: boolean;
	/** The backend applies Backboard memory to the conversation. */
	memory: boolean;
}

/**
 * The model backend contract. `BackboardClient` and `ByokClient` both satisfy
 * it, and `ClientRouter` composes them, so every consumer downstream of this
 * interface is provider-agnostic.
 */
export interface AgentClient {
	readonly capabilities: AgentClientCapabilities;

	/**
	 * Which backend a model routes to. Only a composing client can answer this;
	 * a single-backend client omits it and callers fall back to a default.
	 */
	sourceFor?(model: { provider: string; model: string }): string;
	/** Origin of an existing thread when the client composes multiple backends. */
	sourceForThread?(threadId: string): string;

	/** Streams one assistant turn for a new user message. */
	runMessage(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): AsyncIterable<ProviderEvent>;

	/** Streams the continuation after tool results are submitted. */
	runToolOutputs(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): AsyncIterable<ProviderEvent>;

	/** Keeps a failed/cancelled visible user message in provider-side context. */
	preserveFailedMessage?(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): Promise<string | null>;

	/** Keeps executed tool results in context when their continuation fails. */
	preserveFailedToolOutputs?(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): Promise<string | null>;

	/** Non-streaming single response; used by out-of-band helper requests. */
	sendMessage(
		req: SendMessageRequest,
		options?: RequestOptions,
	): Promise<BackboardResponse>;

	getModelThinkingMetadata(
		provider: string,
		model: string,
		options?: RequestOptions,
	): Promise<ModelThinkingMetadataResponse>;

	listModels(options?: RequestOptions): Promise<ModelsListResponse>;

	listAssistants(
		options?: RequestOptions,
		filter?: { name?: string },
	): Promise<AssistantInfo[]>;

	createAssistant(
		req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options?: RequestOptions,
	): Promise<AssistantInfo>;

	listThreads(options?: RequestOptions): Promise<BackboardThread[]>;

	getThread(
		threadId: string,
		options?: RequestOptions,
	): Promise<BackboardThread>;
}
