import type { ThinkingConfig } from "../../config/defaults.ts";
import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../backboard/types.ts";

/** A local file sent inline with a user message (images are inlined as base64). */
export interface ByokAttachment {
	path: string;
	mediaType: string;
	/** Base64 payload for image parts; absent for files inlined as text. */
	base64?: string;
	/** Decoded text for non-image files small enough to inline. */
	text?: string;
}

export interface ByokToolResult {
	id: string;
	name: string;
	output: string;
}

/**
 * Provider-neutral conversation entry. `ByokClient` keeps the whole thread in
 * this shape and each adapter renders it into its vendor's wire format, so
 * adding a provider never touches conversation bookkeeping.
 */
export type ByokMessage =
	| {
			role: "user";
			content: string;
			displayContent?: string;
			hidden?: boolean;
			attachments?: ByokAttachment[];
	  }
	| {
			role: "assistant";
			content: string;
			toolCalls: ProviderToolCall[];
			/** Serialized opaque provider state that must be replayed. */
			providerMetadata?: string;
			/** Kept in provider context but omitted from the resumed transcript. */
			hidden?: boolean;
	  }
	| { role: "tool"; results: ByokToolResult[] };

export interface ByokStreamRequest {
	/** Vendor model id, e.g. "claude-opus-5" - never the "provider/model" form. */
	model: string;
	systemPrompt: string;
	tools: OpenAITool[];
	messages: readonly ByokMessage[];
	thinking?: ThinkingConfig | null;
	maxOutputTokens?: number;
	/**
	 * Stable per-conversation id. Providers that route by prefix (OpenAI) use it
	 * to keep a conversation landing on the same cache shard.
	 */
	cacheKey?: string;
	signal?: AbortSignal;
}

/**
 * One vendor's HTTP surface, reduced to what the CLI needs. Adapters are
 * stateless: the key is passed per call so `/keys` can swap or disable one
 * without rebuilding anything.
 */
export interface ProviderAdapter {
	readonly id: ByokProviderId;
	/** Display name used in the picker and in error text. */
	readonly label: string;
	/** Where the user gets a key; shown under the paste prompt. */
	readonly consoleUrl: string;
	/** Human hint for the expected key shape, e.g. "sk-ant-...". */
	readonly keyHint: string;

	/** Cheap local shape check run before spending a network round-trip. */
	looksLikeKey(key: string): boolean;

	/**
	 * Confirms the key works. Must reject with a readable message on 401/403
	 * and resolve on success; used by the BYOK setup flow before saving.
	 */
	validateKey(key: string, signal?: AbortSignal): Promise<void>;

	/** The vendor's chat models, already filtered to ones worth selecting. */
	listModels(key: string, signal?: AbortSignal): Promise<ModelCatalogItem[]>;

	/**
	 * Whether this specific model accepts the provider's thinking controls.
	 * Catalog-backed providers may resolve this asynchronously with the active
	 * key; static providers can return their answer directly.
	 */
	supportsThinking(model: string, key: string): boolean | Promise<boolean>;

	/** Streams one assistant turn as the same ProviderEvents Backboard yields. */
	stream(request: ByokStreamRequest, key: string): AsyncIterable<ProviderEvent>;
}
