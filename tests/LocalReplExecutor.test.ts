import { describe, expect, it } from "bun:test";
import { LocalReplExecutor } from "../src/core/agent/rlm/LocalReplExecutor.ts";
import type { LLMBridge } from "../src/core/agent/rlm/RLMTypes.ts";

function echoBridge(): LLMBridge {
	return {
		llm: async (prompt) => `echo:${prompt}`,
		llmBatch: async (prompts) => prompts.map((p) => `echo:${p}`),
	};
}

async function start(context: string): Promise<LocalReplExecutor> {
	const executor = new LocalReplExecutor();
	await executor.init({ context, bridge: echoBridge() });
	return executor;
}

describe("LocalReplExecutor", () => {
	it("exposes the context variable to executed code", async () => {
		const executor = await start("hello world");
		const result = await executor.execute({
			code: "print(context.length)",
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("11");
		await executor.dispose();
	});

	it("exposes structured inputs and safe direct variable bindings", async () => {
		const executor = new LocalReplExecutor();
		await executor.init({
			context: "prompt",
			variables: {
				task: "analyze",
				files: [{ path: "a.ts", text: "export {}" }],
				"not-direct": "still available",
			},
			bridge: echoBridge(),
		});
		const result = await executor.execute({
			code: "print(task); print(files[0].path); print(inputs['not-direct'])",
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("analyze\na.ts\nstill available");
		await executor.dispose();
	});

	it("protects reserved runtime bindings from direct variable overrides", async () => {
		const executor = new LocalReplExecutor();
		await executor.init({
			context: "real context",
			variables: {
				context: "fake context",
				SUBMIT: "fake submit",
				print: "fake print",
			},
			bridge: echoBridge(),
		});
		const result = await executor.execute({
			code: "print(context); print(typeof SUBMIT); print(inputs.context)",
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("real context\nfunction\nfake context");
		await executor.dispose();
	});

	it("persists data across cells via the state object", async () => {
		const executor = await start("");
		await executor.execute({
			code: "state.x = 41 + 1;",
			signal: new AbortController().signal,
		});
		const result = await executor.execute({
			code: "print(state.x)",
			signal: new AbortController().signal,
		});
		expect(result.stdout).toBe("42");
		await executor.dispose();
	});

	it("bridges llm and llm_batch calls back to the host", async () => {
		const executor = await start("");
		const single = await executor.execute({
			code: 'const r = await llm("hi"); print(r);',
			signal: new AbortController().signal,
		});
		expect(single.stdout).toBe("echo:hi");

		const batch = await executor.execute({
			code: 'const r = await llm_batch(["a", "b"]); print(r.join(","));',
			signal: new AbortController().signal,
		});
		expect(batch.stdout).toBe("echo:a,echo:b");
		await executor.dispose();
	});

	it("bridges dspy-style llm_query aliases back to the host", async () => {
		const executor = await start("");
		const single = await executor.execute({
			code: 'const r = await llm_query("hi"); print(r);',
			signal: new AbortController().signal,
		});
		expect(single.stdout).toBe("echo:hi");

		const batch = await executor.execute({
			code: 'const r = await llm_query_batched(["a", "b"]); print(r.join(","));',
			signal: new AbortController().signal,
		});
		expect(batch.stdout).toBe("echo:a,echo:b");
		await executor.dispose();
	});

	it("captures SUBMIT output separately from stdout", async () => {
		const executor = await start("");
		const result = await executor.execute({
			code: 'print("working"); SUBMIT({ answer: "done" }); print("after");',
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("working");
		expect(result.submitted).toEqual({ answer: "done" });
		await executor.dispose();
	});

	it("keeps the first SUBMIT value if user code catches the control signal", async () => {
		const executor = await start("");
		const result = await executor.execute({
			code: 'try { SUBMIT("first"); } catch (err) { SUBMIT("second"); }',
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(true);
		expect(result.submitted).toBe("first");
		await executor.dispose();
	});

	it("reports execution errors without throwing", async () => {
		const executor = await start("");
		const result = await executor.execute({
			code: 'throw new Error("boom")',
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("boom");
		await executor.dispose();
	});

	it("blocks access to the host process from sandbox code", async () => {
		const executor = await start("");
		const result = await executor.execute({
			code: 'print(this.constructor.constructor("return process")().env.HOME)',
			signal: new AbortController().signal,
		});
		expect(result.ok).toBe(false);
		expect(result.stderr).toContain("Code generation from strings disallowed");
		expect(result.stdout).toBe("");
		await executor.dispose();
	});

	it("returns an aborted result when the signal is already aborted", async () => {
		const executor = await start("");
		const controller = new AbortController();
		controller.abort();
		const result = await executor.execute({
			code: "print(1)",
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
		expect(result.stderr).toBe("aborted");
		await executor.dispose();
	});

	it("times out synchronous infinite loops", async () => {
		const executor = await start("");
		await expect(
			executor.execute({
				code: "while (true) {}",
				signal: new AbortController().signal,
				timeoutMs: 10,
			}),
		).rejects.toThrow("timed out");
		await executor.dispose();
	});

	it("can abort async continuations that enter infinite loops", async () => {
		const executor = await start("");
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 10);
		await expect(
			executor.execute({
				code: "await Promise.resolve(); while (true) {}",
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
		await executor.dispose();
	});

	it("throws if execute is called before init", async () => {
		const executor = new LocalReplExecutor();
		await expect(
			executor.execute({
				code: "print(1)",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow("before init");
	});
});
