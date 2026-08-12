import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolCallRef } from "../src/core/bus/events.ts";
import type { HookController } from "../src/core/hooks/index.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { AbortError, ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { makeContext, TestTool } from "./helpers.ts";

function callRef(name: string): ToolCallRef {
	return { id: `call_${name}`, name, input: {} };
}

describe("ToolScheduler", () => {
	it("runs consecutive read-only tools in parallel", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "A",
				readOnly: true,
				delayMs: 30,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
			new TestTool({
				name: "B",
				readOnly: true,
				delayMs: 30,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const ac = new AbortController();

		const outputs = await scheduler.run(
			[callRef("A"), callRef("B")],
			makeContext(ac.signal, bus),
		);

		expect(outputs.length).toBe(2);
		// Both started before either finished.
		expect(order.slice(0, 2).sort()).toEqual(["start:A", "start:B"]);
	});

	it("runs non-concurrency-safe tools serially in order", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "W1",
				readOnly: false,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
			new TestTool({
				name: "W2",
				readOnly: false,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
		]);
		const scheduler = new ToolScheduler(registry, new EventBus());
		const ac = new AbortController();

		await scheduler.run([callRef("W1"), callRef("W2")], makeContext(ac.signal));

		expect(order).toEqual(["start:W1", "end:W1", "start:W2", "end:W2"]);
	});

	it("serializes Computer between read-only tools", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "ReadA",
				readOnly: true,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
			new TestTool({
				name: "Computer",
				readOnly: false,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
			new TestTool({
				name: "ReadB",
				readOnly: true,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
		]);
		const scheduler = new ToolScheduler(registry, new EventBus());

		await scheduler.run(
			[callRef("ReadA"), callRef("Computer"), callRef("ReadB")],
			makeContext(new AbortController().signal),
		);

		expect(order).toEqual([
			"start:ReadA",
			"end:ReadA",
			"start:Computer",
			"end:Computer",
			"start:ReadB",
			"end:ReadB",
		]);
	});

	it("announces the whole round as pending before any call executes", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:pending", (event) => events.push(`pending:${event.name}`));
		bus.on("tool:start", (event) => events.push(`start:${event.name}`));
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
			new TestTool({ name: "W", readOnly: false }),
		]);
		const scheduler = new ToolScheduler(registry, bus);

		await scheduler.run(
			[callRef("R"), callRef("W")],
			makeContext(new AbortController().signal, bus),
		);

		// Both pending rows land before the first tool:start - the queued
		// write call is visible while the read batch is still running.
		expect(events.slice(0, 2)).toEqual(["pending:R", "pending:W"]);
		expect(events).toContain("start:R");
		expect(events).toContain("start:W");
	});

	it("executes lowercase built-in calls while emitting display names", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:start", (event) => events.push(event.name));
		bus.on("tool:result", (event) => events.push(event.name));
		const registry = new ToolRegistry([
			new TestTool({ name: "Execute", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);

		await scheduler.run(
			[callRef("execute")],
			makeContext(new AbortController().signal, bus),
		);

		expect(events).toEqual(["Execute", "Execute"]);
	});

	it("captures tool errors as outputs without aborting the batch", async () => {
		const registry = new ToolRegistry([
			new TestTool({ name: "OK", readOnly: false }),
			new TestTool({ name: "BAD", readOnly: false, throws: true }),
		]);
		const scheduler = new ToolScheduler(registry, new EventBus());
		const ac = new AbortController();

		const outputs = await scheduler.run(
			[callRef("OK"), callRef("BAD")],
			makeContext(ac.signal),
		);
		const bad = outputs.find((o) => o.tool_call_id === "call_BAD");
		expect(bad).toBeDefined();
		if (!bad) throw new Error("expected BAD tool output");
		expect(bad.output.startsWith("Error:")).toBe(true);
		expect(outputs.length).toBe(2);
	});

	it("serializes otherwise parallel tools when matching hooks are configured", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "A",
				readOnly: true,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
			new TestTool({
				name: "B",
				readOnly: true,
				delayMs: 10,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
		]);
		const scheduler = new ToolScheduler(
			registry,
			new EventBus(),
			() => true,
			hookControllerStub({
				hasTrustedToolHooksFor: () => true,
			}),
		);

		await scheduler.run(
			[callRef("A"), callRef("B")],
			makeContext(new AbortController().signal),
		);

		expect(order).toEqual(["start:A", "end:A", "start:B", "end:B"]);
	});

	it("reports unknown tools as error outputs", async () => {
		const scheduler = new ToolScheduler(new ToolRegistry([]), new EventBus());
		const ac = new AbortController();
		const outputs = await scheduler.run(
			[callRef("Nope")],
			makeContext(ac.signal),
		);
		expect(outputs[0]?.output).toContain("unknown tool");
	});

	it("reports disabled tools as error outputs", async () => {
		const registry = new ToolRegistry([new TestTool({ name: "Hidden" })]);
		const scheduler = new ToolScheduler(
			registry,
			new EventBus(),
			(name) => name !== "Hidden",
		);
		const ac = new AbortController();

		const outputs = await scheduler.run(
			[callRef("Hidden")],
			makeContext(ac.signal),
		);

		expect(outputs[0]?.output).toContain("disabled");
	});

	it("suppresses tool:start when cancelled during pre-tool hooks", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:start", (event) => events.push(`start:${event.name}`));
		bus.on("tool:error", (event) => events.push(`error:${event.name}`));
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);
		const ac = new AbortController();
		const scheduler = new ToolScheduler(
			registry,
			bus,
			() => true,
			hookControllerStub({
				runPreToolUse: async (input) => {
					ac.abort();
					return { input: input.toolInput };
				},
			}),
		);

		await expect(
			scheduler.run([callRef("A")], makeContext(ac.signal, bus)),
		).rejects.toBeInstanceOf(AbortError);
		expect(events).toEqual([]);
	});

	it("suppresses tool:result when the turn is cancelled mid-execution", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:result", (event) => events.push(`result:${event.name}`));
		bus.on("tool:error", (event) => events.push(`error:${event.name}`));
		const ac = new AbortController();
		const registry = new ToolRegistry([new OutlivesAbortTool(ac)]);
		const scheduler = new ToolScheduler(registry, bus);

		await expect(
			scheduler.run([callRef("Outlives")], makeContext(ac.signal, bus)),
		).rejects.toBeInstanceOf(AbortError);
		expect(events).toEqual([]);
	});

	it("suppresses tool:result when cancelled during a post-tool hook", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:result", (event) => events.push(`result:${event.name}`));
		bus.on("tool:error", (event) => events.push(`error:${event.name}`));
		const ac = new AbortController();
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);
		const scheduler = new ToolScheduler(
			registry,
			bus,
			() => true,
			hookControllerStub({
				runPostToolUse: async (input) => {
					ac.abort();
					return { output: input.output };
				},
			}),
		);

		await expect(
			scheduler.run([callRef("A")], makeContext(ac.signal, bus)),
		).rejects.toBeInstanceOf(AbortError);
		expect(events).toEqual([]);
	});

	it("suppresses tool:error when cancelled during the error post-hook", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:error", (event) => events.push(`error:${event.name}`));
		bus.on("tool:result", (event) => events.push(`result:${event.name}`));
		const ac = new AbortController();
		const registry = new ToolRegistry([
			new TestTool({ name: "A", readOnly: false, throws: true }),
		]);
		const scheduler = new ToolScheduler(
			registry,
			bus,
			() => true,
			hookControllerStub({
				runPostToolUse: async (input) => {
					ac.abort();
					return { output: input.output };
				},
			}),
		);

		await expect(
			scheduler.run([callRef("A")], makeContext(ac.signal, bus)),
		).rejects.toBeInstanceOf(AbortError);
		expect(events).toEqual([]);
	});

	it("throws AbortError when cancelled before running", async () => {
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);
		const scheduler = new ToolScheduler(registry, new EventBus());
		const ac = new AbortController();
		ac.abort();
		await expect(
			scheduler.run([callRef("A")], makeContext(ac.signal)),
		).rejects.toBeInstanceOf(AbortError);
	});

	it("lets hooks rewrite tool input and append model-visible context", async () => {
		const registry = new ToolRegistry([new TestTool({ name: "RewriteMe" })]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(
			registry,
			bus,
			() => true,
			hookControllerStub({
				runPreToolUse: async (input) => {
					expect(input.turnId).toBe("turn_test");
					expect(input.sessionId).toBe("sess_test");
					expect(input.cwd).toBe(process.cwd());
					return {
						input: { value: "rewritten" },
						additionalContext: "pre context",
					};
				},
				runPostToolUse: async (input) => {
					// Post hooks see the raw tool output, not the hook context decoration.
					expect(input.output).toContain("rewritten");
					expect(input.output).not.toContain("Hook context");
					return {
						output: `${input.output}\npost hook`,
						additionalContext: "post context",
					};
				},
			}),
		);
		const ac = new AbortController();

		const outputs = await scheduler.run([callRef("RewriteMe")], {
			...makeContext(ac.signal, bus),
			turnId: "turn_test",
		});

		expect(outputs[0]?.output).toContain("rewritten");
		expect(outputs[0]?.output).toContain("pre context");
		expect(outputs[0]?.output).toContain("post hook");
		expect(outputs[0]?.output).toContain("post context");
		// Pre- and post-hook context merge into a single model-visible block.
		expect(outputs[0]?.output.match(/Hook context:/g)?.length).toBe(1);
	});

	it("surfaces a PostToolUse deny as a tool error on the success path", async () => {
		const events: string[] = [];
		const bus = new EventBus();
		bus.on("tool:error", (event) => events.push(event.type));
		bus.on("tool:result", (event) => events.push(event.type));
		const registry = new ToolRegistry([new TestTool({ name: "Denied" })]);
		const scheduler = new ToolScheduler(
			registry,
			bus,
			() => true,
			hookControllerStub({
				runPostToolUse: async () => ({
					output: "Error: blocked after run",
					denied: true,
				}),
			}),
		);

		const outputs = await scheduler.run(
			[callRef("Denied")],
			makeContext(new AbortController().signal, bus),
		);

		expect(outputs[0]?.output).toBe("Error: blocked after run");
		expect(events).toContain("tool:error");
		expect(events).not.toContain("tool:result");
	});

	it("returns an error output when a pre-tool hook denies execution", async () => {
		const registry = new ToolRegistry([new TestTool({ name: "Blocked" })]);
		const scheduler = new ToolScheduler(
			registry,
			new EventBus(),
			() => true,
			hookControllerStub({
				runPreToolUse: async (input) => ({
					input: input.toolInput,
					deniedReason: "blocked by policy",
				}),
			}),
		);

		const outputs = await scheduler.run(
			[callRef("Blocked")],
			makeContext(new AbortController().signal),
		);

		expect(outputs[0]?.output).toBe("Error: blocked by policy");
	});

	it("keeps invalid hook rewrites scoped to the tool call", async () => {
		const registry = new ToolRegistry([new TestTool({ name: "BadRewrite" })]);
		const scheduler = new ToolScheduler(
			registry,
			new EventBus(),
			() => true,
			hookControllerStub({
				runPreToolUse: async () => ({ input: { value: 42 } }),
			}),
		);

		const outputs = await scheduler.run(
			[callRef("BadRewrite")],
			makeContext(new AbortController().signal),
		);

		expect(outputs[0]?.output).toContain("pre-tool hook failed");
		expect(outputs[0]?.output.startsWith("Error:")).toBe(true);
	});
});

// Aborts the turn from inside execute, then resolves anyway - the completion
// must stay silent on the bus.
class OutlivesAbortTool extends Tool<Record<string, never>, { value: string }> {
	readonly name = "Outlives";
	readonly inputSchema = z.object({});

	constructor(private readonly controller: AbortController) {
		super();
	}

	override async execute(): Promise<ToolResult<{ value: string }>> {
		this.controller.abort();
		return ok({ value: "done" }, "done", "done");
	}
}

function hookControllerStub(
	methods: Partial<
		Pick<
			HookController,
			"hasTrustedToolHooksFor" | "runPreToolUse" | "runPostToolUse"
		>
	>,
): HookController {
	return {
		hasTrustedToolHooksFor: () => true,
		runPreToolUse: async (input: PreToolUseArgs) => ({
			input: input.toolInput,
		}),
		runPostToolUse: async (input: PostToolUseArgs) => ({
			output: input.output,
		}),
		...methods,
	} as unknown as HookController;
}

type PreToolUseArgs = Parameters<HookController["runPreToolUse"]>[0];
type PostToolUseArgs = Parameters<HookController["runPostToolUse"]>[0];
