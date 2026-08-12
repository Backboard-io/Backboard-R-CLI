import { Worker } from "node:worker_threads";
import { errorMessage } from "../../../utils/errors.ts";
import type {
	LocalReplWorkerRequest,
	LocalReplWorkerResponse,
} from "./LocalReplProtocol.ts";
import { LOCAL_REPL_WORKER_SOURCE } from "./LocalReplWorker.ts";
import type {
	JSONObject,
	LLMBridge,
	REPLExecutor,
	RLMExecObservation,
} from "./RLMTypes.ts";

interface PendingRequest {
	resolve: (message: LocalReplWorkerResponse) => void;
	reject: (err: Error) => void;
}

/**
 * Local JavaScript REPL backend. The public contract is local and lightweight,
 * but generated code runs in a worker thread so runaway async continuations
 * cannot block the CLI event loop. The worker hosts a persistent `node:vm`
 * context and bridges recursive `llm_query` calls back to this process.
 */
export class LocalReplExecutor implements REPLExecutor {
	private worker: Worker | null = null;
	private bridge: LLMBridge | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();

	async init(input: {
		context: string;
		variables?: JSONObject;
		bridge: LLMBridge;
	}): Promise<void> {
		this.bridge = input.bridge;
		this.worker = new Worker(LOCAL_REPL_WORKER_SOURCE, { eval: true });
		this.worker.on("message", (message: LocalReplWorkerResponse) => {
			void this.handleWorkerMessage(message);
		});
		this.worker.on("error", (err: Error) => {
			this.rejectAll(err);
		});
		this.worker.on("exit", (code) => {
			if (code !== 0) {
				this.rejectAll(new Error(`RLM worker exited with code ${code}`));
			}
		});
		await this.request(
			{
				type: "init",
				id: this.nextId++,
				context: input.context,
				variables: input.variables,
			},
			() => undefined,
		);
	}

	async execute(input: {
		code: string;
		signal: AbortSignal;
		timeoutMs?: number;
	}): Promise<RLMExecObservation> {
		if (!this.worker) {
			throw new Error("LocalReplExecutor.execute called before init");
		}
		if (input.signal.aborted) {
			return { ok: false, stdout: "", stderr: "aborted" };
		}

		return this.request(
			{
				type: "execute",
				id: this.nextId++,
				code: input.code,
				timeoutMs: input.timeoutMs,
			},
			(message) => {
				if (message.type !== "executeResult") {
					throw new Error(`Unexpected RLM worker response: ${message.type}`);
				}
				return message.result;
			},
			{
				signal: input.signal,
				timeoutMs:
					input.timeoutMs === undefined ? undefined : input.timeoutMs + 50,
				terminateOnCancel: true,
			},
		);
	}

	async dispose(): Promise<void> {
		const worker = this.worker;
		if (!worker) return;
		try {
			await this.request(
				{ type: "dispose", id: this.nextId++ },
				() => undefined,
				{ timeoutMs: 1_000 },
			);
		} catch {
			// Worker termination below is the durable cleanup path.
		} finally {
			this.worker = null;
			this.bridge = null;
			await worker.terminate();
			this.rejectAll(new Error("RLM worker disposed"));
		}
	}

	private request<T>(
		message: LocalReplWorkerRequest & { id: number },
		readResult: (message: LocalReplWorkerResponse) => T,
		options: {
			signal?: AbortSignal;
			timeoutMs?: number;
			terminateOnCancel?: boolean;
		} = {},
	): Promise<T> {
		if (!this.worker)
			return Promise.reject(new Error("RLM worker not running"));
		return new Promise((resolve, reject) => {
			let timeout: ReturnType<typeof setTimeout> | null = null;
			const cleanup = (): void => {
				if (timeout) clearTimeout(timeout);
				options.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(message.id);
			};
			const fail = (err: Error): void => {
				cleanup();
				if (options.terminateOnCancel) void this.terminateAfterCancel();
				reject(err);
			};
			const onAbort = (): void => {
				fail(new Error("aborted"));
			};
			this.pending.set(message.id, {
				resolve: (response) => {
					cleanup();
					resolve(readResult(response));
				},
				reject: fail,
			});
			if (options.signal) {
				if (options.signal.aborted) return onAbort();
				options.signal.addEventListener("abort", onAbort, { once: true });
			}
			if (options.timeoutMs !== undefined) {
				timeout = setTimeout(() => {
					fail(new Error(`RLM worker timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}
			this.worker?.postMessage(message);
		});
	}

	private async handleWorkerMessage(
		message: LocalReplWorkerResponse,
	): Promise<void> {
		if (message.type === "llmRequest") {
			await this.handleLLMRequest(message);
			return;
		}
		const entry = this.pending.get(message.id);
		if (!entry) return;
		if (message.type === "error") {
			entry.reject(new Error(message.error));
			return;
		}
		if (message.type === "executeResult") {
			entry.resolve(message);
			return;
		}
		entry.resolve(message);
	}

	private async handleLLMRequest(
		message: Extract<LocalReplWorkerResponse, { type: "llmRequest" }>,
	): Promise<void> {
		const worker = this.worker;
		const bridge = this.bridge;
		if (!worker || !bridge) return;
		try {
			const value =
				message.kind === "single"
					? await bridge.llm(message.prompt)
					: await bridge.llmBatch(message.prompts);
			if (this.worker !== worker) return;
			worker.postMessage({
				type: "llmResponse",
				requestId: message.requestId,
				value,
			} satisfies LocalReplWorkerRequest);
		} catch (err) {
			if (this.worker !== worker) return;
			worker.postMessage({
				type: "llmError",
				requestId: message.requestId,
				error: errorMessage(err),
			} satisfies LocalReplWorkerRequest);
		}
	}

	private async terminateAfterCancel(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		if (worker) await worker.terminate();
		this.rejectAll(new Error("RLM worker cancelled"));
	}

	private rejectAll(err: Error): void {
		for (const entry of this.pending.values()) {
			entry.reject(err);
		}
		this.pending.clear();
	}
}
