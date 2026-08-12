import type { ModelRef } from "../config/defaults.ts";
import { formatModel } from "../config/defaults.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import type {
	AgentClient,
	AgentClientCapabilities,
	RequestOptions,
	RunMessageOptions,
} from "./AgentClient.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	ModelCatalogItem,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "./backboard/types.ts";
import { byokAdapterFor } from "./byok/registry.ts";

export type ClientSource = "byok" | "backboard";

export interface ClientRouterDeps {
	backboard?: AgentClient;
	byok?: AgentClient;
	/** The live `/model` selection, used to route requests that carry no thread. */
	getModel: () => ModelRef;
	/**
	 * True when a Backboard sign-in is currently active. Checked per request
	 * rather than at construction, so `/login` and `/logout` take effect on the
	 * next turn. Omit to treat a supplied `backboard` client as always usable.
	 */
	hasBackboardAuth?: () => boolean;
	/** True when an enabled saved key can serve this provider. */
	hasKeyFor: (provider: string) => boolean;
}

/**
 * Routes each request to the backend that can serve it.
 *
 * The precedence rule is the product one: a saved provider key always wins over
 * a Backboard sign-in for the same vendor, so adding a key silently moves those
 * models onto the user's own billing. Requests that name an existing thread
 * route by that thread's origin instead, so toggling a key mid-conversation
 * can never split one thread across two backends.
 */
export class ClientRouter implements AgentClient {
	constructor(private readonly deps: ClientRouterDeps) {}

	/** Which backend owns a given model, honouring key-over-SSO precedence. */
	sourceFor(model: ModelRef = this.deps.getModel()): ClientSource {
		if (
			this.deps.byok &&
			byokAdapterFor(model.provider) &&
			this.deps.hasKeyFor(model.provider)
		) {
			return "byok";
		}
		return this.backboard() ? "backboard" : "byok";
	}

	/** The Backboard client, or undefined while no sign-in is active. */
	private backboard(): AgentClient | undefined {
		if (!this.deps.backboard) return undefined;
		if (this.deps.hasBackboardAuth && !this.deps.hasBackboardAuth()) {
			return undefined;
		}
		return this.deps.backboard;
	}

	get capabilities(): AgentClientCapabilities {
		return this.active().capabilities;
	}

	runMessage(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): AsyncIterable<ProviderEvent> {
		return this.forRequest(req).runMessage(req, options);
	}

	runToolOutputs(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): AsyncIterable<ProviderEvent> {
		return this.forThread(req.thread_id).runToolOutputs(req, options);
	}

	preserveFailedMessage(
		req: SendMessageRequest,
		options?: RunMessageOptions,
	): Promise<string | null> {
		return (
			this.forRequest(req).preserveFailedMessage?.(req, options) ??
			Promise.resolve(null)
		);
	}

	preserveFailedToolOutputs(
		req: SubmitToolOutputsRequest,
		options?: RequestOptions,
	): Promise<string | null> {
		return (
			this.forThread(req.thread_id).preserveFailedToolOutputs?.(req, options) ??
			Promise.resolve(null)
		);
	}

	sourceForThread(threadId: string): ClientSource {
		return threadId.startsWith("byok_") ? "byok" : "backboard";
	}

	sendMessage(
		req: SendMessageRequest,
		options?: RequestOptions,
	): Promise<BackboardResponse> {
		return this.forRequest(req).sendMessage(req, options);
	}

	getModelThinkingMetadata(
		provider: string,
		model: string,
		options?: RequestOptions,
	): Promise<ModelThinkingMetadataResponse> {
		return this.clientFor({ provider, model }).getModelThinkingMetadata(
			provider,
			model,
			options,
		);
	}

	/**
	 * The merged catalog. Signed in, the user sees everything; with keys only,
	 * they see exactly what their keys can reach. Where both offer the same
	 * `provider/model`, the key-backed entry replaces the routed one - matching
	 * where the request would actually go.
	 */
	async listModels(options?: RequestOptions): Promise<ModelsListResponse> {
		const backboardClient = this.backboard();
		const clients = [
			...(this.deps.byok
				? [{ source: "byok" as const, client: this.deps.byok }]
				: []),
			...(backboardClient
				? [{ source: "backboard" as const, client: backboardClient }]
				: []),
		];
		if (clients.length === 0) return { models: [], total: 0 };
		const results = await Promise.allSettled(
			clients.map(({ client }) => client.listModels(options)),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length === results.length) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Failed to list models from every available backend.",
			);
		}
		let byok: ModelsListResponse | undefined;
		let backboard: ModelsListResponse | undefined;
		for (let index = 0; index < results.length; index++) {
			const result = results[index];
			const source = clients[index]?.source;
			if (result?.status !== "fulfilled" || !source) continue;
			if (source === "byok") byok = result.value;
			else backboard = result.value;
		}

		const models: ModelCatalogItem[] = [];
		const seen = new Set<string>();
		for (const model of byok?.models ?? []) {
			seen.add(modelKey(model));
			models.push({ ...model, source: "byok" });
		}
		for (const model of backboard?.models ?? []) {
			if (seen.has(modelKey(model))) continue;
			models.push({ ...model, source: "backboard" });
		}
		return { models, total: models.length };
	}

	listAssistants(
		options?: RequestOptions,
		filter?: { name?: string },
	): Promise<AssistantInfo[]> {
		return this.active().listAssistants(options, filter);
	}

	createAssistant(
		req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options?: RequestOptions,
	): Promise<AssistantInfo> {
		return this.active().createAssistant(req, options);
	}

	async listThreads(options?: RequestOptions): Promise<BackboardThread[]> {
		const clients = [this.deps.byok, this.backboard()].filter(
			(client): client is AgentClient => client !== undefined,
		);
		if (clients.length === 0) return [];
		const results = await Promise.allSettled(
			clients.map((client) => client.listThreads(options)),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length === results.length) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Failed to list sessions from every available backend.",
			);
		}
		const threads = results.flatMap((result) =>
			result.status === "fulfilled" ? result.value : [],
		);
		const seen = new Set<string>();
		return threads.filter((thread) => {
			if (seen.has(thread.thread_id)) return false;
			seen.add(thread.thread_id);
			return true;
		});
	}

	getThread(
		threadId: string,
		options?: RequestOptions,
	): Promise<BackboardThread> {
		return this.forThread(threadId).getThread(threadId, options);
	}

	/**
	 * Where a request belongs: its thread's backend if it names one, otherwise
	 * the backend for the model it asks for.
	 *
	 * Both entry points route this way. `sendMessage` used to fall back to the
	 * live `/model` selection and ignore the request entirely, which sent RLM
	 * legs - they carry their own model and thread - to whichever backend the
	 * picker happened to be on.
	 */
	private forRequest(req: SendMessageRequest): AgentClient {
		if (req.thread_id) return this.forThread(req.thread_id);
		const model = this.deps.getModel();
		return this.clientFor({
			provider: req.llm_provider ?? model.provider,
			model: req.model_name ?? model.model,
		});
	}

	private active(): AgentClient {
		return this.clientFor(this.deps.getModel());
	}

	private clientFor(model: ModelRef): AgentClient {
		const source = this.sourceFor(model);
		const client = source === "byok" ? this.deps.byok : this.backboard();
		if (!client) {
			throw new Error(
				`No backend can serve ${formatModel(model)}. Sign in with Backboard or add a key with /keys.`,
			);
		}
		return client;
	}

	/** BYOK mints thread ids with a `byok_` prefix; Backboard ids never collide. */
	private forThread(threadId: string): AgentClient {
		if (threadId.startsWith("byok_") && this.deps.byok) return this.deps.byok;
		const backboard = this.backboard();
		if (!threadId.startsWith("byok_") && backboard) return backboard;
		return this.active();
	}
}

function modelKey(model: ModelCatalogItem): string {
	return `${model.provider.trim().toLowerCase()}/${model.name.trim().toLowerCase()}`;
}
