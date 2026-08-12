import { describe, expect, it } from "bun:test";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	BackboardThread,
	ModelsListResponse,
	ProviderEvent,
	SendMessageRequest,
	SubmitToolOutputsRequest,
} from "../src/providers/backboard/types.ts";
import { ClientRouter } from "../src/providers/ClientRouter.ts";

class RecordingClient {
	readonly messages: SendMessageRequest[] = [];
	readonly sent: SendMessageRequest[] = [];
	readonly toolOutputs: SubmitToolOutputsRequest[] = [];

	constructor(
		readonly name: string,
		readonly capabilities: AgentClient["capabilities"],
		private readonly models: ModelsListResponse["models"] = [],
		readonly threads: BackboardThread[] = [],
	) {}

	async *runMessage(req: SendMessageRequest): AsyncIterable<ProviderEvent> {
		this.messages.push(req);
		yield { kind: "completed" };
	}

	async *runToolOutputs(
		req: SubmitToolOutputsRequest,
	): AsyncIterable<ProviderEvent> {
		this.toolOutputs.push(req);
		yield { kind: "completed" };
	}

	async sendMessage(req: SendMessageRequest): Promise<unknown> {
		this.sent.push(req);
		return { thread_id: "t", content: "", status: "COMPLETED" };
	}

	async listModels(): Promise<ModelsListResponse> {
		return { models: this.models, total: this.models.length };
	}

	async listThreads(): Promise<BackboardThread[]> {
		return this.threads;
	}

	async getThread(threadId: string): Promise<BackboardThread> {
		const thread = this.threads.find(
			(candidate) => candidate.thread_id === threadId,
		);
		if (!thread) throw new Error(`missing ${threadId}`);
		return thread;
	}
}

function backboard(models: ModelsListResponse["models"] = []): RecordingClient {
	return new RecordingClient(
		"backboard",
		{ assistants: true, threads: true, memory: true },
		models,
	);
}

function byok(models: ModelsListResponse["models"] = []): RecordingClient {
	return new RecordingClient(
		"byok",
		{ assistants: false, threads: false, memory: false },
		models,
	);
}

async function drain(stream: AsyncIterable<ProviderEvent>): Promise<void> {
	for await (const _event of stream) {
		// consume
	}
}

function router(options: {
	backboardClient?: RecordingClient;
	byokClient?: RecordingClient;
	model?: { provider: string; model: string };
	keyed?: string[];
	signedIn?: boolean;
}): ClientRouter {
	return new ClientRouter({
		...(options.backboardClient
			? { backboard: options.backboardClient as unknown as AgentClient }
			: {}),
		...(options.byokClient
			? { byok: options.byokClient as unknown as AgentClient }
			: {}),
		getModel: () =>
			options.model ?? { provider: "anthropic", model: "claude-opus-5" },
		...(options.signedIn === undefined
			? {}
			: { hasBackboardAuth: () => options.signedIn === true }),
		hasKeyFor: (provider) => (options.keyed ?? []).includes(provider),
	});
}

describe("ClientRouter precedence", () => {
	it("reports thread origin independently of the active model", () => {
		const client = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["anthropic"],
		});

		expect(client.sourceForThread("byok_saved")).toBe("byok");
		expect(client.sourceForThread("thread_backboard")).toBe("backboard");
	});

	it("prefers a saved key over Backboard for the same vendor", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["anthropic"],
			}).sourceFor({ provider: "anthropic", model: "claude-opus-5" }),
		).toBe("byok");
	});

	it("falls back to Backboard when no key covers the vendor", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["openai"],
			}).sourceFor({ provider: "anthropic", model: "claude-opus-5" }),
		).toBe("backboard");
	});

	it("falls back to Backboard for vendors with no adapter at all", () => {
		expect(
			router({
				backboardClient: backboard(),
				byokClient: byok(),
				keyed: ["cohere"],
			}).sourceFor({ provider: "cohere", model: "command-a" }),
		).toBe("backboard");
	});

	it("reports the active backend's capabilities", () => {
		const withKey = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: ["anthropic"],
		});
		expect(withKey.capabilities.assistants).toBe(false);

		const withoutKey = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
		});
		expect(withoutKey.capabilities.assistants).toBe(true);
	});
});

describe("ClientRouter request routing", () => {
	it("routes a new message by the selected model", async () => {
		const bb = backboard();
		const key = byok();
		await drain(
			router({
				backboardClient: bb,
				byokClient: key,
				keyed: ["anthropic"],
			}).runMessage({
				content: "hi",
				llm_provider: "anthropic",
				model_name: "claude-opus-5",
			}),
		);

		expect(key.messages).toHaveLength(1);
		expect(bb.messages).toHaveLength(0);
	});

	it("keeps a thread on its original backend even after keys change", async () => {
		const bb = backboard();
		const key = byok();
		// A Backboard thread with an anthropic key now enabled would otherwise
		// flip mid-conversation to a backend that has never seen it.
		const target = router({
			backboardClient: bb,
			byokClient: key,
			keyed: ["anthropic"],
		});

		await drain(
			target.runMessage({
				content: "hi",
				thread_id: "thread_abc",
				llm_provider: "anthropic",
				model_name: "claude-opus-5",
			}),
		);
		await drain(
			target.runToolOutputs({
				thread_id: "thread_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(bb.messages).toHaveLength(1);
		expect(bb.toolOutputs).toHaveLength(1);
		expect(key.messages).toHaveLength(0);
	});

	it("routes byok_ threads to the key-backed client", async () => {
		const bb = backboard();
		const key = byok();
		await drain(
			router({
				backboardClient: bb,
				byokClient: key,
				keyed: [],
			}).runToolOutputs({
				thread_id: "byok_abc",
				tool_outputs: [{ tool_call_id: "1", output: "ok" }],
			}),
		);

		expect(key.toolOutputs).toHaveLength(1);
		expect(bb.toolOutputs).toHaveLength(0);
	});
});

describe("ClientRouter catalog", () => {
	const anthropicModel = {
		name: "claude-opus-5",
		provider: "anthropic",
		model_type: "llm",
	};
	const openaiModel = {
		name: "gpt-5.5",
		provider: "openai",
		model_type: "llm",
	};

	it("merges both catalogs and tags each entry with its source", async () => {
		const result = await router({
			backboardClient: backboard([openaiModel]),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([
			{ ...anthropicModel, source: "byok" },
			{ ...openaiModel, source: "backboard" },
		]);
	});

	it("lets the key-backed entry win a duplicate", async () => {
		const result = await router({
			backboardClient: backboard([anthropicModel, openaiModel]),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toHaveLength(2);
		expect(
			result.models.find((model) => model.name === "claude-opus-5")?.source,
		).toBe("byok");
	});

	it("shows only key-backed models when there is no sign-in", async () => {
		const result = await router({
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([{ ...anthropicModel, source: "byok" }]);
	});

	it("keeps the available catalog when one backend fails", async () => {
		class FailingModelClient extends RecordingClient {
			override async listModels(): Promise<ModelsListResponse> {
				throw new Error("catalog unavailable");
			}
		}
		const result = await router({
			backboardClient: new FailingModelClient("backboard", {
				assistants: true,
				threads: true,
				memory: true,
			}),
			byokClient: byok([anthropicModel]),
			keyed: ["anthropic"],
		}).listModels();

		expect(result.models).toEqual([{ ...anthropicModel, source: "byok" }]);
	});

	it("fails only when every available catalog fails", async () => {
		class FailingModelClient extends RecordingClient {
			override async listModels(): Promise<ModelsListResponse> {
				throw new Error(`${this.name} unavailable`);
			}
		}
		await expect(
			router({
				backboardClient: new FailingModelClient("backboard", {
					assistants: true,
					threads: true,
					memory: true,
				}),
				byokClient: new FailingModelClient("byok", {
					assistants: false,
					threads: false,
					memory: false,
				}),
				keyed: ["anthropic"],
			}).listModels(),
		).rejects.toThrow("Failed to list models from every available backend");
	});
});

describe("ClientRouter.sendMessage routing", () => {
	// RLM legs carry their own model and thread through sendMessage. Routing on
	// the live `/model` selection instead sent them to the wrong backend.
	it("routes by the request's model, not the picker selection", async () => {
		const backboardClient = backboard();
		const byokClient = byok();
		await router({
			backboardClient,
			byokClient,
			model: { provider: "anthropic", model: "claude-opus-5" },
			keyed: ["anthropic"],
		}).sendMessage({
			content: "hi",
			llm_provider: "openai",
			model_name: "gpt-5.1",
		});

		// The picker is on a keyed vendor, but the request names an unkeyed one.
		expect(byokClient.sent).toHaveLength(0);
		expect(backboardClient.sent).toHaveLength(1);
	});

	it("routes by the thread's origin when the request names one", async () => {
		const backboardClient = backboard();
		const byokClient = byok();
		await router({
			backboardClient,
			byokClient,
			keyed: ["anthropic"],
		}).sendMessage({ content: "hi", thread_id: "thread_backboard" });

		expect(byokClient.sent).toHaveLength(0);
		expect(backboardClient.sent).toHaveLength(1);
	});
});

describe("ClientRouter sign-in state", () => {
	// The Backboard client is constructed unconditionally so a mid-session
	// /login works without a restart; routing has to gate on live auth instead.
	it("ignores the Backboard client while no sign-in is active", () => {
		const routed = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
			signedIn: false,
		});

		expect(routed.sourceFor({ provider: "anthropic", model: "x" })).toBe(
			"byok",
		);
	});

	it("routes to Backboard once a sign-in lands", () => {
		const routed = router({
			backboardClient: backboard(),
			byokClient: byok(),
			keyed: [],
			signedIn: true,
		});

		expect(routed.sourceFor({ provider: "anthropic", model: "x" })).toBe(
			"backboard",
		);
	});
});

describe("ClientRouter sessions", () => {
	const localThread: BackboardThread = {
		thread_id: "byok_local",
		messages: [],
	};
	const remoteThread: BackboardThread = {
		thread_id: "thread_remote",
		messages: [],
	};

	it("merges local BYOK and Backboard sessions", async () => {
		const local = new RecordingClient(
			"byok",
			{ assistants: false, threads: true, memory: false },
			[],
			[localThread],
		);
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);

		expect(
			await router({
				backboardClient: remote,
				byokClient: local,
				keyed: ["anthropic"],
			}).listThreads(),
		).toEqual([localThread, remoteThread]);
	});

	it("keeps successful Backboard sessions when the local store fails", async () => {
		class FailingListClient extends RecordingClient {
			override async listThreads(): Promise<BackboardThread[]> {
				throw new Error("local sessions unreadable");
			}
		}
		const local = new FailingListClient("byok", {
			assistants: false,
			threads: true,
			memory: false,
		});
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);

		expect(
			await router({
				backboardClient: remote,
				byokClient: local,
				keyed: ["anthropic"],
			}).listThreads(),
		).toEqual([remoteThread]);
	});

	it("loads a session from the backend that owns its thread id", async () => {
		const local = new RecordingClient(
			"byok",
			{ assistants: false, threads: true, memory: false },
			[],
			[localThread],
		);
		const remote = new RecordingClient(
			"backboard",
			{ assistants: true, threads: true, memory: true },
			[],
			[remoteThread],
		);
		const target = router({
			backboardClient: remote,
			byokClient: local,
			keyed: ["anthropic"],
		});

		expect(await target.getThread("byok_local")).toBe(localThread);
		expect(await target.getThread("thread_remote")).toBe(remoteThread);
	});
});
