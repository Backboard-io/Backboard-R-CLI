import { describe, expect, it } from "bun:test";
import { LocalReplExecutor } from "../src/core/agent/rlm/LocalReplExecutor.ts";
import { extractCodeBlock, RLMLoop } from "../src/core/agent/rlm/RLMLoop.ts";
import type {
	JSONValue,
	LLMBridge,
	REPLExecutor,
	RLMExecObservation,
} from "../src/core/agent/rlm/RLMTypes.ts";
import type { RequestOptions } from "../src/providers/backboard/BackboardClient.ts";
import type {
	BackboardResponse,
	RawToolCall,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { TEST_MODEL } from "./helpers/agent.ts";

function response(content: string, threadId = "thr_1"): BackboardResponse {
	return {
		thread_id: threadId,
		content,
		status: "COMPLETED",
		tool_calls: null,
		input_tokens: 1,
		output_tokens: 1,
		total_tokens: 2,
	};
}

function requiresAction(
	calls: RawToolCall[],
	threadId = "thr_1",
): BackboardResponse {
	return {
		thread_id: threadId,
		content: null,
		status: "REQUIRES_ACTION",
		tool_calls: calls,
		input_tokens: 1,
		output_tokens: 1,
		total_tokens: 2,
	};
}

class ScriptedClient {
	requests: SendMessageRequest[] = [];
	constructor(private readonly script: BackboardResponse[]) {}
	async sendMessage(
		req: SendMessageRequest,
		_options?: RequestOptions,
	): Promise<BackboardResponse> {
		this.requests.push(req);
		const next = this.script.shift();
		if (!next) throw new Error("ScriptedClient ran out of responses");
		return next;
	}
}

class HangingSummaryClient {
	requests: SendMessageRequest[] = [];
	summarySignal: AbortSignal | undefined;

	async sendMessage(
		req: SendMessageRequest,
		options?: RequestOptions,
	): Promise<BackboardResponse> {
		this.requests.push(req);
		if (this.requests.length === 1) {
			return response("Reasoning\n```js\nwhile (await never()) {}\n```");
		}
		this.summarySignal = options?.signal;
		await new Promise<void>((resolve) => {
			if (!options?.signal || options.signal.aborted) return resolve();
			options.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		throw new Error("summary aborted");
	}
}

class FakeExecutor implements REPLExecutor {
	codes: string[] = [];
	initVariables: Record<string, JSONValue> | undefined;
	disposed = false;
	constructor(private readonly outputs: RLMExecObservation[]) {}
	async init(input: {
		context: string;
		variables?: Record<string, JSONValue>;
		bridge: LLMBridge;
	}): Promise<void> {
		this.initVariables = input.variables;
	}
	async execute(input: {
		code: string;
		signal: AbortSignal;
	}): Promise<RLMExecObservation> {
		this.codes.push(input.code);
		return this.outputs.shift() ?? { ok: true, stdout: "", stderr: "" };
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class FailingInitExecutor implements REPLExecutor {
	disposed = false;

	async init(): Promise<void> {
		throw new Error("init failed");
	}

	async execute(): Promise<RLMExecObservation> {
		throw new Error("execute should not run");
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class WaitForAbortExecutor implements REPLExecutor {
	codes: string[] = [];
	disposed = false;
	async init(_input: {
		context: string;
		variables?: Record<string, JSONValue>;
		bridge: LLMBridge;
	}): Promise<void> {}
	async execute(input: {
		code: string;
		signal: AbortSignal;
	}): Promise<RLMExecObservation> {
		this.codes.push(input.code);
		await new Promise<void>((resolve) => {
			if (input.signal.aborted) return resolve();
			input.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		throw new Error("aborted");
	}
	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

interface TestClient {
	sendMessage(
		req: SendMessageRequest,
		options?: RequestOptions,
	): Promise<BackboardResponse>;
}

interface LoopOptions {
	maxIterations?: number;
	maxLLMCalls?: number;
	timeoutSummaryMs?: number;
}

function loopWith(
	client: TestClient,
	executor: REPLExecutor,
	options: LoopOptions = {},
): RLMLoop {
	return new RLMLoop({
		client,
		model: TEST_MODEL,
		executor,
		...options,
	});
}

function runParams(
	prompt: string,
	options: { signal?: AbortSignal } = {},
): {
	prompt: string;
	signal: AbortSignal;
} {
	const signal = options.signal ?? new AbortController().signal;
	return {
		prompt,
		signal,
	};
}

describe("RLMLoop helpers", () => {
	it("extracts the first fenced code block", () => {
		expect(extractCodeBlock("text\n```js\nprint(1)\n```\nmore")).toBe(
			"print(1)",
		);
		expect(extractCodeBlock("```\nx=1\n```")).toBe("x=1");
		expect(extractCodeBlock("no code here")).toBeNull();
	});
});

describe("RLMLoop", () => {
	it("executes code actions until SUBMIT returns the final answer", async () => {
		const client = new ScriptedClient([
			response("Reasoning\n```js\nprint(context)\n```"),
			response("```js\nSUBMIT('the answer')\n```"),
		]);
		const executor = new FakeExecutor([
			{ ok: true, stdout: "hi", stderr: "" },
			{ ok: true, stdout: "", stderr: "", submitted: "the answer" },
		]);
		const result = await loopWith(client, executor).run({
			...runParams("hi"),
		});

		expect(result.status).toBe("completed");
		expect(result.report).toBe("the answer");
		expect(result.rounds).toBe(2);
		expect(executor.codes).toEqual(["print(context)", "SUBMIT('the answer')"]);
		expect(executor.disposed).toBe(true);
		expect(result.usage.totalTokens).toBe(4);
		expect(client.requests[0]?.content).toContain("Write exactly one fenced");
		expect(client.requests[0]?.content).toContain("length: 2");
		expect(client.requests[1]?.content).toContain("stdout:\n  hi");
	});

	it("keeps printed stdout in the trajectory when a cell submits", async () => {
		const client = new ScriptedClient([response("```js\nSUBMIT('done')\n```")]);
		const executor = new FakeExecutor([
			{ ok: true, stdout: "debug line", stderr: "", submitted: "done" },
		]);
		const result = await loopWith(client, executor).run(runParams("q"));

		expect(result.report).toBe("done");
		expect(result.trajectory[0]?.output).toContain("stdout:\ndebug line");
		expect(result.trajectory[0]?.output).toContain("SUBMIT: done");
	});

	it("feeds missing code back as an error instead of final prose", async () => {
		const client = new ScriptedClient([
			response("It is 7."),
			response("```js\nSUBMIT('recovered')\n```"),
		]);
		const executor = new FakeExecutor([
			{ ok: true, stdout: "", stderr: "", submitted: "recovered" },
		]);
		const result = await loopWith(client, executor).run(runParams("q"));
		expect(result.report).toBe("recovered");
		expect(result.rounds).toBe(2);
		expect(client.requests[1]?.content).toContain("No JavaScript code block");
	});

	it("feeds native provider tool calls back as RLM errors", async () => {
		const client = new ScriptedClient([
			requiresAction([
				{
					id: "call_1",
					type: "function",
					function: { name: "Read", arguments: "{}" },
				},
			]),
			response("```js\nSUBMIT('handled')\n```"),
		]);
		const executor = new FakeExecutor([
			{ ok: true, stdout: "", stderr: "", submitted: "handled" },
		]);
		const result = await loopWith(client, executor).run(
			runParams("read a file"),
		);
		expect(result.report).toBe("handled");
		expect(result.rounds).toBe(2);
		expect(client.requests[1]?.content).toContain(
			"Native provider tool calls are not available inside RLM (Read)",
		);
	});

	it("uses extract fallback when max iterations finish without SUBMIT", async () => {
		const client = new ScriptedClient([
			response("```js\nprint(1)\n```"),
			response("fallback answer"),
		]);
		const executor = new FakeExecutor([{ ok: true, stdout: "1", stderr: "" }]);
		const result = await loopWith(client, executor, { maxIterations: 1 }).run(
			runParams("loop forever"),
		);
		expect(result.rounds).toBe(1);
		expect(result.status).toBe("completed");
		expect(result.report).toBe("fallback answer");
		expect(client.requests[1]?.content).toContain("ended before SUBMIT");
	});

	it("returns cancelled when cancelled mid-run", async () => {
		const controller = new AbortController();
		const client = new ScriptedClient([response("```js\nprint(1)\n```")]);
		const executor: REPLExecutor = {
			async init() {},
			async execute() {
				controller.abort();
				return { ok: true, stdout: "1", stderr: "" };
			},
			async dispose() {},
		};
		const result = await loopWith(client, executor).run(
			runParams("q", { signal: controller.signal }),
		);
		expect(result.status).toBe("cancelled");
		expect(client.requests).toHaveLength(1);
	});

	it("disposes the executor when initialization fails", async () => {
		const client = new ScriptedClient([]);
		const executor = new FailingInitExecutor();

		await expect(
			loopWith(client, executor).run(runParams("q")),
		).rejects.toThrow("init failed");
		expect(executor.disposed).toBe(true);
		expect(client.requests).toHaveLength(0);
	});

	it("returns a partial summary when the RLM timeout expires", async () => {
		const client = new ScriptedClient([
			response("Reasoning\n```js\nwhile (await never()) {}\n```"),
			response("Partial: inspected the prompt but timed out before finishing."),
		]);
		const executor = new WaitForAbortExecutor();
		const result = await loopWith(client, executor).run({
			...runParams("investigate slowly"),
			timeoutMs: 10,
		});

		expect(result.status).toBe("timed_out");
		expect(result.report).toContain("Partial:");
		expect(result.rounds).toBe(1);
		expect(result.trajectory).toHaveLength(1);
		expect(result.trajectory[0]?.output).toContain("aborted");
		expect(executor.codes).toEqual(["while (await never()) {}"]);
		expect(executor.disposed).toBe(true);
		expect(client.requests[1]?.content).toContain("wall-clock budget expired");
		expect(client.requests[1]?.content).toContain("investigate slowly");
	});

	it("caps timeout summary generation separately from the parent signal", async () => {
		const client = new HangingSummaryClient();
		const executor = new WaitForAbortExecutor();
		const startedAt = Date.now();

		const result = await loopWith(client, executor, {
			timeoutSummaryMs: 5,
		}).run({
			...runParams("investigate slowly"),
			timeoutMs: 10,
		});

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(result.status).toBe("timed_out");
		expect(result.report).toContain("summary aborted");
		expect(client.requests).toHaveLength(2);
		expect(client.summarySignal?.aborted).toBe(true);
	});

	it("bridges recursive llm_query calls back through the client", async () => {
		const client = new ScriptedClient([
			response(
				"```js\nconst r = await llm_query('inner question'); print(r); SUBMIT(r)\n```",
			),
			response("LEAF ANSWER"),
		]);
		const result = await loopWith(client, new LocalReplExecutor()).run(
			runParams("use a sub-model"),
		);

		expect(result.report).toBe("LEAF ANSWER");
		expect(client.requests).toHaveLength(2);
		expect(client.requests[1]?.content).toBe("inner question");
		expect(client.requests[1]?.system_prompt).toBeUndefined();
	});

	it("exposes prompt and structured variables to the RLM sandbox", async () => {
		const client = new ScriptedClient([
			response(
				"```js\nSUBMIT({ task, first: files[0].path, viaInputs: inputs.files[0].text, context })\n```",
			),
		]);

		const result = await loopWith(client, new LocalReplExecutor()).run({
			...runParams("summarize files"),
			variables: {
				files: [{ path: "sample.txt", text: "hello" }],
			},
		});

		expect(result.report).toBe(
			JSON.stringify(
				{
					task: "summarize files",
					first: "sample.txt",
					viaInputs: "hello",
					context: "summarize files",
				},
				null,
				2,
			),
		);
		expect(client.requests[0]?.content).toContain("files");
		expect(client.requests).toHaveLength(1);
	});

	it("rejects oversized recursive batches atomically", async () => {
		const client = new ScriptedClient([
			response(
				"```js\ntry { await llm_query_batched(['a', 'b', 'c']); SUBMIT('unexpected'); } catch (err) { SUBMIT(err instanceof Error ? err.message : String(err)); }\n```",
			),
		]);

		const result = await loopWith(client, new LocalReplExecutor(), {
			maxLLMCalls: 2,
		}).run(runParams("batch too large"));

		expect(result.report).toContain("llm_query budget exceeded (2)");
		expect(client.requests).toHaveLength(1);
	});
});
