import { basename } from "node:path";
import type { BackboardEnv } from "../../config/env.ts";
import type { ServerEventLog } from "../../core/session/ServerEventLog.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import { errorMessage } from "../../utils/errors.ts";
import type {
	AgentClient,
	AgentClientCapabilities,
	RequestOptions,
	RunMessageOptions,
} from "../AgentClient.ts";
import { MODEL_PAGE_LIMIT } from "./constants.ts";
import { BackboardError, BackboardTransportError } from "./errors.ts";
import { BackboardStreamEventMapper } from "./mappers.ts";
import { isSelectableProvider } from "./modelCatalog.ts";
import { parseSseFrame, readSseFrames } from "./sse.ts";
import type {
	AssistantInfo,
	BackboardResponse,
	BackboardThread,
	ModelCatalogItem,
	ModelsListResponse,
	ModelThinkingMetadataResponse,
	ProviderEvent,
	ProvidersListResponse,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "./types.ts";

export type {
	RequestOptions,
	RunMessageOptions,
} from "../AgentClient.ts";

/** JSON-encodes the object-valued request fields the form path expects as strings. */
function messageFormData(
	req: SendMessageRequest & { stream: boolean },
	filePaths: string[],
): FormData {
	const form = new FormData();
	for (const [key, value] of Object.entries(req)) {
		if (value === undefined || value === null) continue;
		if (typeof value === "object") {
			form.append(key, JSON.stringify(value));
		} else {
			form.append(key, String(value));
		}
	}
	for (const filePath of filePaths) {
		form.append("files", Bun.file(filePath), basename(filePath));
	}
	return form;
}

/**
 * Backboard transport. JSON helpers keep the simple request/response endpoints
 * available; the run generators consume Backboard's SSE turn streams.
 */
export class BackboardClient implements AgentClient {
	/** Backboard holds threads, assistants, and memory server-side. */
	readonly capabilities: AgentClientCapabilities = {
		assistants: true,
		threads: true,
		memory: true,
	};

	constructor(
		private readonly env: BackboardEnv,
		private readonly serverLog?: ServerEventLog,
	) {}

	private headers(): Record<string, string> {
		return {
			"X-API-Key": this.env.apiKey,
			"Content-Type": "application/json",
		};
	}

	private async post<T>(
		path: string,
		body: unknown,
		options: RequestOptions,
	): Promise<T> {
		const url = `${this.env.apiUrl}${path}`;
		const headers = this.headers();
		const started = Date.now();

		this.serverLog?.request({ endpoint: path, method: "POST", headers, body });

		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options.signal,
			});
		} catch (err) {
			this.serverLog?.response({
				endpoint: path,
				method: "POST",
				status: 0,
				body: null,
				latencyMs: Date.now() - started,
				error: errorMessage(err),
			});
			throw err;
		}

		const text = await res.text();
		const parsed = safeJson(text);

		this.serverLog?.response({
			endpoint: path,
			method: "POST",
			status: res.status,
			body: parsed,
			latencyMs: Date.now() - started,
			...(res.ok ? {} : { error: `HTTP ${res.status}` }),
		});

		if (!res.ok) {
			throw new BackboardError(
				`Backboard request failed: HTTP ${res.status}`,
				res.status,
				parsed,
			);
		}

		return parsed as T;
	}

	private async get<T>(path: string, options: RequestOptions): Promise<T> {
		const url = `${this.env.apiUrl}${path}`;
		const headers = this.headers();
		const started = Date.now();
		this.serverLog?.request({
			endpoint: path,
			method: "GET",
			headers,
			body: null,
		});

		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: options.signal,
		});
		const text = await res.text();
		const parsed = safeJson(text);

		this.serverLog?.response({
			endpoint: path,
			method: "GET",
			status: res.status,
			body: parsed,
			latencyMs: Date.now() - started,
			...(res.ok ? {} : { error: `HTTP ${res.status}` }),
		});

		if (!res.ok) {
			throw new BackboardError(
				`Backboard request failed: HTTP ${res.status}`,
				res.status,
				parsed,
			);
		}

		return parsed as T;
	}

	async sendMessage(
		req: SendMessageRequest,
		options: RequestOptions = {},
	): Promise<BackboardResponse> {
		return this.post<BackboardResponse>("/threads/messages", req, options);
	}

	async *runMessage(
		req: SendMessageRequest,
		options: RunMessageOptions = {},
	): AsyncIterable<ProviderEvent> {
		const body = options.attachmentFilePaths?.length
			? messageFormData({ ...req, stream: true }, options.attachmentFilePaths)
			: { ...req, stream: true };
		yield* this.postStream("/threads/messages", body, options);
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
		options: RequestOptions = {},
	): AsyncIterable<ProviderEvent> {
		if (req.run_id) {
			const { run_id: runId, thread_id: threadId, ...body } = req;
			yield* this.postStream(
				`/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/submit-tool-outputs?stream=true`,
				{ ...body, stream: true },
				options,
			);
			return;
		}
		yield* this.postStream(
			"/threads/tool-outputs",
			{ ...req, stream: true },
			options,
		);
	}

	async listModels(options: RequestOptions = {}): Promise<ModelsListResponse> {
		const providers = await this.listModelProviders(options);
		const pages = await Promise.all(
			providers.map((provider) =>
				this.listModelPages(
					`/models/provider/${encodeURIComponent(provider)}`,
					{},
					options,
				),
			),
		);
		return {
			models: pages.flatMap((page) => page.models),
			total: pages.reduce((sum, page) => sum + page.total, 0),
		};
	}

	async getModelThinkingMetadata(
		provider: string,
		model: string,
		options: RequestOptions = {},
	): Promise<ModelThinkingMetadataResponse> {
		const query = new URLSearchParams({ provider, model });
		return this.get<ModelThinkingMetadataResponse>(
			`/models/thinking-metadata?${query}`,
			options,
		);
	}

	async listAssistants(
		options: RequestOptions = {},
		filter: { name?: string } = {},
	): Promise<AssistantInfo[]> {
		const query = new URLSearchParams({ limit: "200" });
		// Exact-name filter keeps the response to one small record instead of
		// every assistant's full system prompt (~5MB at limit=200). Older
		// servers ignore the param and return the full list, which callers
		// still .find() over, so this stays backward compatible.
		if (filter.name) query.set("name", filter.name);
		return this.get<AssistantInfo[]>(`/assistants?${query}`, options);
	}

	async listThreads(options: RequestOptions = {}): Promise<BackboardThread[]> {
		return this.get<BackboardThread[]>(
			"/threads?limit=200&include_messages=false",
			options,
		);
	}

	async getThread(
		threadId: string,
		options: RequestOptions = {},
	): Promise<BackboardThread> {
		return this.get<BackboardThread>(
			`/threads/${encodeURIComponent(threadId)}`,
			options,
		);
	}

	async createAssistant(
		req: { name: string; system_prompt: string; tools: OpenAITool[] },
		options: RequestOptions = {},
	): Promise<AssistantInfo> {
		return this.post<AssistantInfo>("/assistants", req, options);
	}

	private async listModelPages(
		path: string,
		params: Readonly<Record<string, string>>,
		options: RequestOptions,
	): Promise<ModelsListResponse> {
		const models: ModelCatalogItem[] = [];
		let skip = 0;
		let total = 0;

		while (true) {
			const page = await this.get<ModelsListResponse>(
				`${path}?${modelPageQuery(params, skip)}`,
				options,
			);
			models.push(...page.models);
			total = page.total;
			if (models.length >= total || page.models.length === 0) {
				return { models, total };
			}
			skip += page.models.length;
		}
	}

	private async listModelProviders(options: RequestOptions): Promise<string[]> {
		const result = await this.get<ProvidersListResponse>(
			"/models/providers",
			options,
		);
		return result.providers.filter(isSelectableProvider);
	}

	private async *postStream(
		path: string,
		body: unknown,
		options: RequestOptions,
	): AsyncIterable<ProviderEvent> {
		const isForm = body instanceof FormData;
		const headers = this.headers();
		if (isForm) delete headers["Content-Type"];
		const started = Date.now();
		let status = 0;
		let events = 0;
		let lastEvent: ProviderEvent | null = null;
		let error: string | undefined;
		let errorLogged = false;

		this.serverLog?.request({
			endpoint: path,
			method: "POST",
			headers,
			body: isForm
				? { multipart: true, fields: Array.from((body as FormData).keys()) }
				: body,
		});

		try {
			const res = await fetch(`${this.env.apiUrl}${path}`, {
				method: "POST",
				headers,
				body: isForm ? (body as FormData) : JSON.stringify(body),
				signal: options.signal,
			});
			status = res.status;

			if (!res.ok) {
				const parsed = safeJson(await res.text());
				error = `HTTP ${status}`;
				errorLogged = true;
				this.serverLog?.response({
					endpoint: path,
					method: "POST",
					status,
					body: parsed,
					latencyMs: Date.now() - started,
					error,
				});
				throw new BackboardError(
					`Backboard request failed: HTTP ${status}`,
					status,
					parsed,
				);
			}
			if (!res.body) {
				throw new BackboardError(
					"Backboard stream response did not include a body",
					status,
					null,
				);
			}

			const mapper = new BackboardStreamEventMapper();
			for await (const frame of readSseFrames(res.body)) {
				let payload: unknown;
				try {
					payload = parseSseFrame(frame);
				} catch (err) {
					error = errorMessage(err);
					const failure: ProviderEvent = {
						kind: "failed",
						error: `Malformed Backboard stream event: ${error}`,
					};
					events++;
					lastEvent = failure;
					yield failure;
					return;
				}
				if (payload == null) continue;
				for (const event of mapper.map(payload)) {
					events++;
					lastEvent = event;
					yield event;
				}
			}
		} catch (err) {
			error ??= errorMessage(err);
			if (isAbortError(err) || err instanceof BackboardError) {
				throw err;
			}
			throw new BackboardTransportError(
				`Backboard stream failed for ${path}: ${error}`,
				path,
				status === 0 ? "request" : "stream",
				err,
			);
		} finally {
			if (!errorLogged) {
				this.serverLog?.response({
					endpoint: path,
					method: "POST",
					status,
					body: { stream: true, events, lastEvent },
					latencyMs: Date.now() - started,
					...(error ? { error } : {}),
				});
			}
		}
	}
}

function modelPageQuery(
	params: Readonly<Record<string, string>>,
	skip: number,
): string {
	const query = new URLSearchParams(params);
	query.set("skip", String(skip));
	query.set("limit", String(MODEL_PAGE_LIMIT));
	return query.toString();
}

function safeJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
