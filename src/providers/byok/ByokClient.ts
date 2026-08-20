import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";
import type { ServerEventLog } from "../../core/session/ServerEventLog.ts";
import { errorMessage } from "../../utils/errors.ts";
import { shortId } from "../../utils/id.ts";
import type {
	AgentClient,
	AgentClientCapabilities,
	RequestOptions,
	RunMessageOptions,
} from "../AgentClient.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	ProviderToolCall,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../backboard/types.ts";
import { loadAttachments } from "./attachments.ts";
import type {
	ByokConversationStore,
	StoredByokConversation,
} from "./ByokConversationStore.ts";
import { repairInterruptedToolTurn } from "./ByokConversationStore.ts";
import { ByokError, unexpectedStreamEndMessage } from "./ByokError.ts";
import type {
	ByokAttachment,
	ByokMessage,
	ProviderAdapter,
} from "./ByokTypes.ts";
import { BYOK_ADAPTER_LIST, byokAdapterFor } from "./registry.ts";

/** Resolves the usable key for a provider, or null when none is enabled. */
export type ProviderKeyResolver = (provider: ByokProviderId) => string | null;

/**
 * A locally held conversation. Vendor APIs are stateless, so the client keeps
 * what Backboard would keep server-side - including the turn settings that
 * `submit-tool-outputs` does not resend.
 */
/** Ceiling on retained conversations; see `threads`. */
const MAX_LIVE_THREADS = 64;

interface ByokThread {
	messages: ByokMessage[];
	provider: ByokProviderId;
	model: string;
	systemPrompt: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	dirty: boolean;
	durableSession?: {
		sessionId: string;
		sessionRoot: string;
		replacesThreadId?: string;
	};
}

interface StreamAttemptState {
	keepInput: boolean;
}

export const BYOK_THREAD_METADATA_KEY = "backboard_byok";
export const BYOK_SESSION_ROOT_METADATA_KEY = "backboard_session_root";
export const BYOK_SESSION_ID_METADATA_KEY = "backboard_session_id";

export class ByokConversationNotFoundError extends Error {
	readonly threadId: string;

	constructor(threadId: string) {
		super(`Saved conversation ${threadId} was not found.`);
		this.name = "ByokConversationNotFoundError";
		this.threadId = threadId;
	}
}

/**
 * Drives direct vendor APIs behind the same contract as `BackboardClient`.
 *
 * The one real difference between the two backends is where conversation state
 * lives: Backboard holds it under a thread id, and here it is held in-process
 * under a locally minted one. Everything above this class - the agent loop,
 * tool scheduling, the event bus, the UI - sees identical `ProviderEvent`
 * streams and cannot tell which backend produced them.
 */
export class ByokClient implements AgentClient {
	readonly capabilities: AgentClientCapabilities = {
		// Vendor APIs have no assistant records or Backboard memory. Durable
		// threads are provided by the local conversation store.
		assistants: false,
		threads: true,
		memory: false,
	};

	/**
	 * Live conversations, newest last. Bounded because throwaway threads are
	 * routine - every `/new`, every compaction summary - and each holds a full
	 * message history that would otherwise live as long as the process. The cap
	 * is far above any plausible number of *active* conversations, so eviction
	 * only ever reaches abandoned ones.
	 */
	private readonly threads = new Map<string, ByokThread>();
	private readonly attachmentsByOptions = new WeakMap<
		RunMessageOptions,
		Promise<ByokAttachment[]>
	>();

	constructor(
		private readonly resolveKey: ProviderKeyResolver,
		private readonly serverLog?: ServerEventLog,
		private readonly conversationStore?: ByokConversationStore,
	) {}

	async *runMessage(
		req: SendMessageRequest,
		options: RunMessageOptions = {},
	): AsyncIterable<ProviderEvent> {
		const adapter = this.adapterFor(req.llm_provider);
		const key = this.keyFor(adapter);
		const model = req.model_name?.trim();
		if (!model) {
			throw new ByokError(
				"No model was selected for this request.",
				adapter.id,
				0,
				null,
			);
		}

		// A named thread this client does not hold must fail rather than be
		// adopted with an empty history: the caller believes it is continuing a
		// conversation, and answering from nothing would send only the newest
		// message while the UI still shows the full transcript - context lost
		// with no visible sign. Reachable when a Backboard thread falls through
		// to this client, e.g. after `/logout` mid-session.
		let threadId = req.thread_id;
		if (threadId && !this.threads.has(threadId)) {
			await this.loadStoredThread(threadId);
		}
		if (threadId && !this.threads.has(threadId)) {
			throw new ByokError(
				`Unknown conversation ${threadId}. Start a new one with /new.`,
				adapter.id,
				0,
				null,
			);
		}
		if (!threadId) {
			const replacedRevision = await this.replacedRevision(
				options.durableSession?.replacesThreadId,
				options.durableSession?.sessionRoot,
			);
			threadId = shortId("byok");
			this.evictOldestThreads();
			const now = new Date().toISOString();
			this.threads.set(threadId, {
				messages: [],
				provider: adapter.id,
				model,
				systemPrompt: req.system_prompt ?? "",
				createdAt: now,
				updatedAt: now,
				revision: replacedRevision,
				dirty: false,
				...(options.durableSession
					? { durableSession: options.durableSession }
					: {}),
			});
			yield { kind: "thread", threadId };
		}
		// Present by construction: either just minted, or the guard above proved
		// the client holds it.
		const thread = this.touch(threadId) as ByokThread;
		// `/model` can switch mid-thread; the newest turn's settings win, exactly
		// as they would on a Backboard thread.
		thread.provider = adapter.id;
		thread.model = model;
		if (req.system_prompt !== undefined) {
			thread.systemPrompt = req.system_prompt;
		}
		const repaired = repairInterruptedToolTurn(thread.messages);
		if (repaired.length !== thread.messages.length) {
			thread.messages.splice(0, thread.messages.length, ...repaired);
		}

		const messageCount = thread.messages.length;
		thread.messages.push(await this.userMessage(req, options));
		const attempt: StreamAttemptState = { keepInput: false };
		try {
			for await (const event of this.streamTurn(
				adapter,
				key,
				thread,
				req.tools ?? [],
				{
					thinking: req.thinking,
					cacheKey: threadId,
					attempt,
					...(options.signal ? { signal: options.signal } : {}),
				},
			)) {
				yield event;
			}
		} finally {
			if (!attempt.keepInput) thread.messages.splice(messageCount);
		}
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
		options: RequestOptions = {},
	): AsyncIterable<ProviderEvent> {
		let thread = this.touch(req.thread_id);
		if (!thread) {
			await this.loadStoredThread(req.thread_id, {
				repairInterruptedToolTurn: false,
			});
			thread = this.touch(req.thread_id);
		}
		if (!thread) {
			yield {
				kind: "failed",
				error: `Unknown conversation ${req.thread_id}; start a new one with /new.`,
			};
			return;
		}
		const adapter = this.adapterFor(thread.provider);
		const key = this.keyFor(adapter);

		// Tool results must name the call they answer: Gemini pairs by function
		// name, and every backend needs the name for the transcript.
		const names = toolCallNames(thread.messages);
		const missingCall = req.tool_outputs.find(
			(output) => !names.has(output.tool_call_id),
		);
		if (missingCall) {
			yield {
				kind: "failed",
				error: `Tool result ${missingCall.tool_call_id} no longer has a matching pending tool call. Resume the conversation and try the turn again.`,
			};
			return;
		}
		const messageCount = thread.messages.length;
		thread.messages.push(toolResultsMessage(req.tool_outputs, names));
		const attempt: StreamAttemptState = { keepInput: false };
		try {
			for await (const event of this.streamTurn(
				adapter,
				key,
				thread,
				req.tools ?? [],
				{
					thinking: req.thinking,
					cacheKey: req.thread_id,
					attempt,
					...(options.signal ? { signal: options.signal } : {}),
				},
			)) {
				yield event;
			}
		} finally {
			if (!attempt.keepInput) thread.messages.splice(messageCount);
		}
	}

	async preserveFailedMessage(
		req: SendMessageRequest,
		options: RunMessageOptions = {},
	): Promise<string | null> {
		if (!req.thread_id) return null;
		let thread = this.touch(req.thread_id);
		if (!thread) {
			await this.loadStoredThread(req.thread_id);
			thread = this.touch(req.thread_id);
		}
		if (!thread) return null;
		thread.messages.push(await this.userMessage(req, options));
		thread.messages.push({
			role: "assistant",
			content: "The previous response failed before it completed.",
			toolCalls: [],
			hidden: true,
		});
		return await this.persistThread(req.thread_id, thread);
	}

	async preserveFailedToolOutputs(
		req: SubmitToolOutputsRequest,
	): Promise<string | null> {
		let thread = this.touch(req.thread_id);
		if (!thread) {
			await this.loadStoredThread(req.thread_id, {
				repairInterruptedToolTurn: false,
			});
			thread = this.touch(req.thread_id);
		}
		if (!thread) return null;
		const names = toolCallNames(thread.messages);
		if (req.tool_outputs.some((output) => !names.has(output.tool_call_id))) {
			return `Failed to preserve tool results for conversation ${req.thread_id}: a matching tool call was not found.`;
		}
		thread.messages.push(toolResultsMessage(req.tool_outputs, names));
		thread.messages.push({
			role: "assistant",
			content: "The previous tool continuation failed before it completed.",
			toolCalls: [],
			hidden: true,
		});
		return await this.persistThread(req.thread_id, thread);
	}

	/**
	 * Streams one assistant turn and commits only provider-accepted output.
	 * Failed attempts are rolled back by the caller so stream retries cannot
	 * replay a duplicate user/tool message or a partial answer the UI discarded.
	 */
	private async *streamTurn(
		adapter: ProviderAdapter,
		key: string,
		thread: ByokThread,
		tools: SubmitToolOutputsRequest["tools"],
		options: {
			thinking?: SendMessageRequest["thinking"];
			signal?: AbortSignal;
			cacheKey?: string;
			attempt: StreamAttemptState;
		},
	): AsyncIterable<ProviderEvent> {
		const started = Date.now();
		let text = "";
		const calls: ProviderToolCall[] = [];
		let committed = false;
		let terminal = false;
		let events = 0;
		let error: string | undefined;
		let providerMetadata: string | undefined;

		const commit = async (): Promise<string | null> => {
			if (committed) return null;
			committed = true;
			if (text || calls.length > 0) {
				thread.messages.push({
					role: "assistant",
					content: text,
					toolCalls: calls,
					...(providerMetadata ? { providerMetadata } : {}),
				});
			}
			const threadId = options.cacheKey;
			const warning = threadId
				? await this.persistThread(threadId, thread)
				: null;
			options.attempt.keepInput = true;
			return warning;
		};

		this.serverLog?.request({
			endpoint: `byok:${adapter.id}`,
			method: "POST",
			// The key never reaches the log.
			headers: { provider: adapter.id, model: thread.model },
			body: { messages: thread.messages.length, tools: tools?.length ?? 0 },
		});

		try {
			for await (const event of adapter.stream(
				{
					model: thread.model,
					systemPrompt: thread.systemPrompt,
					tools: tools ?? [],
					messages: thread.messages,
					thinking: options.thinking,
					...(options.cacheKey ? { cacheKey: options.cacheKey } : {}),
					...(options.signal ? { signal: options.signal } : {}),
				},
				key,
			)) {
				events++;
				if (event.kind === "assistant_delta") text += event.text;
				if (event.kind === "tool_ready") calls.push(event.call);
				if (event.kind === "completed") {
					terminal = true;
					if (event.finalText) text = event.finalText;
					const warning = await commit();
					if (warning) yield { kind: "warning", message: warning };
				}
				if (event.kind === "requires_action") {
					terminal = true;
					providerMetadata = event.providerMetadata;
					const warning = await commit();
					if (warning) yield { kind: "warning", message: warning };
				}
				if (event.kind === "failed") {
					terminal = true;
					error = event.error;
				}
				yield event;
			}
			if (!terminal) {
				throw new ByokError(
					unexpectedStreamEndMessage(adapter.id),
					adapter.id,
					0,
					null,
				);
			}
		} catch (err) {
			error = errorMessage(err);
			if (options.signal?.aborted && !committed) {
				thread.messages.push({
					role: "assistant",
					content:
						text ||
						"The previous response was interrupted before it completed.",
					toolCalls: [],
					...(text ? {} : { hidden: true }),
				});
				const threadId = options.cacheKey;
				const warning = threadId
					? await this.persistThread(threadId, thread)
					: null;
				options.attempt.keepInput = true;
				if (warning) yield { kind: "warning", message: warning };
			}
			throw err;
		} finally {
			this.serverLog?.response({
				endpoint: `byok:${adapter.id}`,
				method: "POST",
				status: error ? 0 : 200,
				body: { stream: true, events, toolCalls: calls.length },
				latencyMs: Date.now() - started,
				...(error ? { error } : {}),
			});
		}
	}

	async sendMessage(
		req: SendMessageRequest,
		options: RequestOptions = {},
	): Promise<BackboardResponse> {
		let content = "";
		let threadId = req.thread_id ?? "";
		const toolCalls: ProviderToolCall[] = [];
		let failure: string | null = null;

		for await (const event of this.runMessage(req, options)) {
			if (event.kind === "thread") threadId = event.threadId;
			if (event.kind === "assistant_delta") content += event.text;
			if (event.kind === "tool_ready") toolCalls.push(event.call);
			if (event.kind === "completed" && event.finalText) {
				content = event.finalText;
			}
			if (event.kind === "failed") failure = event.error;
		}
		if (failure) {
			throw new ByokError(
				failure,
				this.adapterFor(req.llm_provider).id,
				0,
				null,
			);
		}

		return {
			thread_id: threadId,
			content,
			status: toolCalls.length > 0 ? "REQUIRES_ACTION" : "COMPLETED",
			tool_calls:
				toolCalls.length > 0
					? toolCalls.map((call) => ({
							id: call.id,
							type: "function" as const,
							function: {
								name: call.name,
								arguments: JSON.stringify(call.input ?? {}),
							},
						}))
					: null,
			model_provider: req.llm_provider ?? null,
			model_name: req.model_name ?? null,
		};
	}

	/** Resolve provider-specific thinking support with the active BYOK key. */
	async getModelThinkingMetadata(
		provider: string,
		model: string,
	): Promise<ModelThinkingMetadataResponse> {
		const adapter = byokAdapterFor(provider);
		return {
			provider,
			model,
			supports_thinking: adapter
				? await adapter.supportsThinking(model, this.keyFor(adapter))
				: false,
		};
	}

	/** Every model reachable with a currently enabled key. */
	async listModels(options: RequestOptions = {}): Promise<ModelsListResponse> {
		const results = await Promise.all(
			BYOK_ADAPTER_LIST.map(async (adapter) => {
				const key = this.resolveKey(adapter.id);
				if (!key) return [];
				try {
					return await adapter.listModels(key, options.signal);
				} catch {
					// One vendor being down or its key revoked must not empty the
					// whole picker.
					return [];
				}
			}),
		);
		const models = results.flat();
		return { models, total: models.length };
	}

	async listAssistants(): Promise<AssistantInfo[]> {
		return [];
	}

	async createAssistant(): Promise<AssistantInfo> {
		throw new Error("Assistants are a Backboard feature and need a sign-in.");
	}

	async listThreads(): Promise<BackboardThread[]> {
		if (!this.conversationStore) return [];
		return (await this.conversationStore.list()).map(storedThread);
	}

	async getThread(threadId: string): Promise<BackboardThread> {
		const live = this.threads.get(threadId);
		const stored =
			live?.durableSession && this.conversationStore
				? await this.conversationStore.getAtSessionRoot(
						live.durableSession.sessionRoot,
						threadId,
					)
				: await this.conversationStore?.get(threadId);
		if (stored) {
			if (
				live &&
				(live.revision > stored.revision ||
					(live.dirty && live.revision >= stored.revision) ||
					(live.revision === stored.revision &&
						live.updatedAt > stored.updatedAt))
			) {
				return liveThread(threadId, live);
			}
			this.rememberStoredThread(stored);
			return storedThread(stored);
		}
		const thread = this.threads.get(threadId);
		if (thread?.durableSession) return liveThread(threadId, thread);
		if (!thread) {
			throw new ByokConversationNotFoundError(threadId);
		}
		return liveThread(threadId, thread);
	}

	/**
	 * Marks a thread as most recently used, and returns it.
	 *
	 * Map iteration is insertion order, so eviction is only least-*recently*-used
	 * if using a thread re-inserts it. Without this it is least-recently-*created*
	 * - and the live conversation is typically the oldest entry in the map, minted
	 * at session start with every throwaway (subagent run, RLM leg, compaction
	 * summary) inserted after it. Eviction would reach the one thread that must
	 * never be dropped first, and the unknown-thread guard would then turn the
	 * next turn into a hard failure mid-session.
	 */
	private touch(threadId: string): ByokThread | undefined {
		const thread = this.threads.get(threadId);
		if (!thread) return undefined;
		this.threads.delete(threadId);
		this.threads.set(threadId, thread);
		return thread;
	}

	/** Drops the least recently used threads once the map is full. */
	private evictOldestThreads(): void {
		while (this.threads.size >= MAX_LIVE_THREADS) {
			const oldest = this.threads.keys().next();
			if (oldest.done) return;
			this.threads.delete(oldest.value);
		}
	}

	private async loadStoredThread(
		threadId: string,
		options: { repairInterruptedToolTurn?: boolean } = {},
	): Promise<void> {
		const stored = await this.conversationStore?.get(threadId, options);
		if (stored) this.rememberStoredThread(stored);
	}

	private async replacedRevision(
		threadId: string | undefined,
		sessionRoot: string | undefined,
	): Promise<number> {
		if (!threadId) return 0;
		const live = this.threads.get(threadId);
		if (live) return live.revision;
		const stored =
			sessionRoot && this.conversationStore
				? await this.conversationStore.getAtSessionRoot(sessionRoot, threadId, {
						repairInterruptedToolTurn: false,
					})
				: await this.conversationStore?.get(threadId, {
						repairInterruptedToolTurn: false,
					});
		if (stored) return stored.revision;
		throw new Error(
			`Cannot replace conversation ${threadId} because its saved revision is unavailable.`,
		);
	}

	private rememberStoredThread(stored: StoredByokConversation): void {
		const replacing = this.threads.delete(stored.threadId);
		if (!replacing) this.evictOldestThreads();
		this.threads.set(stored.threadId, {
			messages: [...stored.messages],
			provider: stored.provider,
			model: stored.model,
			systemPrompt: stored.systemPrompt,
			createdAt: stored.createdAt,
			updatedAt: stored.updatedAt,
			revision: stored.revision,
			dirty: false,
			durableSession: {
				sessionId: stored.sessionId,
				sessionRoot: stored.sessionRoot,
			},
		});
	}

	private async persistThread(
		threadId: string,
		thread: ByokThread,
	): Promise<string | null> {
		if (!thread.durableSession || !this.conversationStore) return null;
		thread.updatedAt = new Date().toISOString();
		try {
			thread.revision = await this.conversationStore.save(
				{
					version: 1,
					revision: thread.revision,
					threadId,
					sessionId: thread.durableSession.sessionId,
					sessionRoot: thread.durableSession.sessionRoot,
					provider: thread.provider,
					model: thread.model,
					systemPrompt: thread.systemPrompt,
					createdAt: thread.createdAt,
					updatedAt: thread.updatedAt,
					messages: thread.messages,
				},
				thread.revision,
				thread.durableSession.replacesThreadId,
			);
			thread.dirty = false;
			delete thread.durableSession.replacesThreadId;
			return null;
		} catch (error) {
			thread.dirty = true;
			return `The response completed, but saving this BYOK conversation failed: ${errorMessage(error)}`;
		}
	}

	private async userMessage(
		req: SendMessageRequest,
		options: RunMessageOptions,
	): Promise<ByokMessage> {
		let attachmentLoad = this.attachmentsByOptions.get(options);
		if (!attachmentLoad) {
			attachmentLoad = options.attachmentFilePaths?.length
				? loadAttachments(options.attachmentFilePaths)
				: Promise.resolve([]);
			this.attachmentsByOptions.set(options, attachmentLoad);
		}
		const attachments = await attachmentLoad;
		return {
			role: "user",
			content: req.content,
			...(options.displayContent !== undefined
				? { displayContent: options.displayContent }
				: {}),
			...(req.metadata?.injected_notification != null ? { hidden: true } : {}),
			...(attachments.length > 0 ? { attachments } : {}),
		};
	}

	private adapterFor(provider: string | undefined): ProviderAdapter {
		const adapter = provider ? byokAdapterFor(provider) : null;
		if (!adapter) {
			throw new Error(
				`No API key provider handles "${provider ?? "unknown"}". Run /keys to add one, or sign in with Backboard for the full catalog.`,
			);
		}
		return adapter;
	}

	private keyFor(adapter: ProviderAdapter): string {
		const key = this.resolveKey(adapter.id);
		if (!key) {
			throw new Error(
				`No enabled ${adapter.label} API key. Add or enable one with /keys.`,
			);
		}
		return key;
	}
}

function toolCallNames(messages: readonly ByokMessage[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const call of message.toolCalls) names.set(call.id, call.name);
	}
	return names;
}

function toolResultsMessage(
	outputs: SubmitToolOutputsRequest["tool_outputs"],
	names: ReadonlyMap<string, string>,
): ByokMessage {
	return {
		role: "tool",
		results: outputs.map((output) => ({
			id: output.tool_call_id,
			name: names.get(output.tool_call_id) as string,
			output: output.output,
		})),
	};
}

function storedThread(conversation: StoredByokConversation): BackboardThread {
	return liveThread(conversation.threadId, {
		messages: conversation.messages,
		provider: conversation.provider,
		model: conversation.model,
		systemPrompt: conversation.systemPrompt,
		createdAt: conversation.createdAt,
		updatedAt: conversation.updatedAt,
		revision: conversation.revision,
		dirty: false,
		durableSession: {
			sessionId: conversation.sessionId,
			sessionRoot: conversation.sessionRoot,
		},
	});
}

function liveThread(threadId: string, thread: ByokThread): BackboardThread {
	const firstUser = thread.messages.find(
		(message) => message.role === "user" && !message.hidden,
	);
	return {
		thread_id: threadId,
		title:
			firstUser?.role === "user"
				? visibleUserContent(firstUser).replace(/\s+/g, " ").trim().slice(0, 60)
				: null,
		first_user_message:
			firstUser?.role === "user" ? visibleUserContent(firstUser) : null,
		message_count: thread.messages.filter(
			(message) =>
				message.role !== "tool" && !("hidden" in message && message.hidden),
		).length,
		created_at: thread.createdAt,
		updated_at: thread.updatedAt,
		metadata_: {
			[BYOK_THREAD_METADATA_KEY]: true,
			[BYOK_SESSION_ROOT_METADATA_KEY]:
				thread.durableSession?.sessionRoot ?? "",
			[BYOK_SESSION_ID_METADATA_KEY]: thread.durableSession?.sessionId ?? "",
			model_provider: thread.provider,
			model_name: thread.model,
		},
		messages: thread.messages.flatMap(
			(message, index): BackboardThread["messages"] => {
				const createdAt = thread.updatedAt;
				if (message.role === "user") {
					if (message.hidden) return [];
					return [
						{
							message_id: `${threadId}-user-${index}`,
							role: "user" as const,
							content: visibleUserContent(message),
							created_at: createdAt,
						},
					];
				}
				if (message.role === "assistant") {
					if (message.hidden) return [];
					return [
						{
							message_id: `${threadId}-assistant-${index}`,
							role: "assistant" as const,
							content: message.content,
							created_at: createdAt,
							model_provider: thread.provider,
							model_name: thread.model,
							metadata_: {
								tool_calls: message.toolCalls.map((call) => ({
									id: call.id,
									type: "function",
									function: {
										name: call.name,
										arguments: JSON.stringify(call.input ?? {}),
									},
								})),
							},
						},
					];
				}
				return message.results.map((result, resultIndex) => ({
					message_id: `${threadId}-tool-${index}-${resultIndex}`,
					role: "tool" as const,
					content: result.output,
					created_at: createdAt,
					status: "COMPLETED",
					metadata_: {
						tool_call_id: result.id,
						tool_name: result.name,
					},
				}));
			},
		),
	};
}

function visibleUserContent(
	message: Extract<ByokMessage, { role: "user" }>,
): string {
	return message.displayContent?.trim()
		? message.displayContent
		: message.content;
}
