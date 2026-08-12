import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolCallRef } from "../src/core/bus/events.ts";
import { HookController } from "../src/core/hooks/index.ts";
import type { LoadedHook } from "../src/core/hooks/types.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { mapStreamPayloadToEvents } from "../src/providers/backboard/mappers.ts";
import { makeContext, TestTool } from "./helpers.ts";

function callRef(name: string, input: unknown = {}): ToolCallRef {
	return { id: `call_${name}`, name, input };
}

describe("ToolCallRound", () => {
	it("starts a safe offered call before finalize and reuses its result", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "R",
				readOnly: true,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			}),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		// Started during streaming, before the final list arrives.
		await Bun.sleep(0);
		expect(order).toContain("start:R");

		const outputs = await round.finalize([callRef("R")]);
		expect(outputs.length).toBe(1);
		expect(outputs[0]?.tool_call_id).toBe("call_R");
		// The early run was reused, not re-executed.
		expect(order.filter((entry) => entry === "start:R").length).toBe(1);
	});

	it("defers non-safe calls to finalize and blocks later early starts", async () => {
		const order: string[] = [];
		const track = (name: string, readOnly: boolean) =>
			new TestTool({
				name,
				readOnly,
				onStart: (n) => order.push(`start:${n}`),
				onEnd: (n) => order.push(`end:${n}`),
			});
		const registry = new ToolRegistry([track("W", false), track("R2", true)]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("W"));
		round.offer(callRef("R2"));
		await Bun.sleep(5);
		// Nothing ran early: the write defers, and the read behind it must not
		// jump ahead of the write.
		expect(order).toEqual([]);

		const outputs = await round.finalize([callRef("W"), callRef("R2")]);
		expect(outputs.map((o) => o.tool_call_id)).toEqual(["call_W", "call_R2"]);
		expect(order).toEqual(["start:W", "end:W", "start:R2", "end:R2"]);
	});

	it("blocks early start while an announced call has not become ready", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({ name: "A", readOnly: true }),
			new TestTool({
				name: "B",
				readOnly: true,
				onStart: (n) => order.push(`start:${n}`),
			}),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		// A's name streamed but its args never finished (e.g. zero-arg tool):
		// B must not start early because A's safety is still unknown.
		round.announce("call_A", "A");
		round.offer(callRef("B"));
		await Bun.sleep(5);
		expect(order).toEqual([]);
	});

	it("dedupes duplicate offers by id", async () => {
		let runs = 0;
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true, onStart: () => runs++ }),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		round.offer(callRef("R"));
		await round.finalize([callRef("R")]);
		expect(runs).toBe(1);
	});

	it("discards early results absent from the final list", async () => {
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
			new TestTool({ name: "S", readOnly: true }),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		round.offer(callRef("S"));
		const outputs = await round.finalize([callRef("S")]);
		expect(outputs.map((o) => o.tool_call_id)).toEqual(["call_S"]);
	});

	it("reset() forgets early state so finalize re-runs everything", async () => {
		let runs = 0;
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true, onStart: () => runs++ }),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		await Bun.sleep(0);
		round.reset();
		const outputs = await round.finalize([callRef("R")]);
		expect(outputs.length).toBe(1);
		expect(runs).toBe(2);
	});

	it("reset() aborts in-flight early runs and retracts announced rows", async () => {
		const retracted: string[] = [];
		const ended: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({
				name: "R",
				readOnly: true,
				delayMs: 20,
				onEnd: (n) => ended.push(n),
			}),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.announce("call_other", "R");
		round.offer(callRef("R"));
		await Bun.sleep(0);
		round.reset();
		await Bun.sleep(30);
		// The orphaned run was aborted mid-flight, and both announced rows
		// were retracted so the UI can drop them.
		expect(ended).toEqual([]);
		expect(retracted.sort()).toEqual(["call_R", "call_other"]);

		// The round stays usable for the retry attempt.
		const outputs = await round.finalize([callRef("R")]);
		expect(outputs.length).toBe(1);
		expect(ended).toEqual(["R"]);
	});

	it("finalize retracts streamed rows absent from the authoritative list", async () => {
		const retracted: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
			new TestTool({ name: "S", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		// R's args never finish streaming, so it never executes; nothing
		// early-starts while it is announced-but-not-ready.
		round.announce("call_R", "R");
		round.offer(callRef("S"));
		await round.finalize([callRef("S")]);
		expect(retracted).toEqual(["call_R"]);
	});

	it("finalize aborts an unconfirmed early run and retracts its row", async () => {
		const retracted: string[] = [];
		const ended: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({
				name: "R",
				readOnly: true,
				delayMs: 20,
				onEnd: (n) => ended.push(n),
			}),
			new TestTool({ name: "S", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		round.offer(callRef("S"));
		await round.finalize([callRef("S")]);
		await Bun.sleep(30);
		// The orphaned early run was aborted (never finished) and its
		// still-unfinished row was retracted.
		expect(ended).toEqual([]);
		expect(retracted).toEqual(["call_R"]);
	});

	it("does not retract a row whose early run already completed", async () => {
		const retracted: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
			new TestTool({ name: "S", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R"));
		// Let the early run settle: its tool:result already rendered (and may
		// have drained to static scrollback), so it must survive both the
		// finalize retraction and a later reset().
		await Bun.sleep(5);
		const outputs = await round.finalize([callRef("S")]);
		expect(outputs.map((o) => o.tool_call_id)).toEqual(["call_S"]);
		round.reset();
		expect(retracted).toEqual([]);
	});

	it("a completed id from a previous attempt stays retractable after reset()", async () => {
		const retracted: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		// Attempt 1: the early run completes, so reset() keeps its row.
		round.offer(callRef("R"));
		await Bun.sleep(5);
		round.reset();
		expect(retracted).toEqual([]);

		// Attempt 2 re-streams the same id but never confirms it; the stale
		// "settled" memory from attempt 1 must not suppress this retraction,
		// or the new pending row would pin the live region forever.
		round.announce("call_R", "R");
		round.reset();
		expect(retracted).toEqual(["call_R"]);
	});

	it("reset() after a mid-finalize abort keeps completed rows, drops the rest", async () => {
		const retracted: string[] = [];
		const bus = new EventBus();
		bus.on("tool:retracted", (event) => retracted.push(event.toolCallId));
		const abort = new AbortController();
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
			new TestTool({
				name: "W",
				readOnly: false,
				delayMs: 20,
				onStart: () => abort.abort(),
			}),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(makeContext(abort.signal, bus));

		// R completes, then W aborts the turn mid-run (Esc). The finally-style
		// reset must not retract R's completed row - only W's unfinished one.
		await expect(
			round.finalize([callRef("R"), callRef("W")]),
		).rejects.toThrow();
		round.reset();
		expect(retracted).toEqual(["call_W"]);
	});

	it("re-runs an early call whose authoritative input diverged", async () => {
		const inputs: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "R",
				readOnly: true,
				onStart: (n) => inputs.push(n),
			}),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("R", { value: "streamed" }));
		await Bun.sleep(0);
		const outputs = await round.finalize([callRef("R", { value: "final" })]);
		// The early result ran with stale args and must not be reused.
		expect(inputs.length).toBe(2);
		expect(outputs[0]?.output).toBe("final");
	});

	it("does not early-start a concurrency-safe but write-capable tool", async () => {
		const order: string[] = [];
		class SafeWriteTool extends TestTool {
			override isReadOnly(): boolean {
				return false;
			}
			override isConcurrencySafe(): boolean {
				return true;
			}
		}
		const registry = new ToolRegistry([
			new SafeWriteTool({ name: "AgentLike", onStart: (n) => order.push(n) }),
		]);
		const bus = new EventBus();
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.offer(callRef("AgentLike"));
		await Bun.sleep(5);
		expect(order).toEqual([]);
		const outputs = await round.finalize([callRef("AgentLike")]);
		expect(outputs.length).toBe(1);
		expect(order).toEqual(["AgentLike"]);
	});

	it("does not early-start a tool that has Pre/PostToolUse hooks configured", async () => {
		const order: string[] = [];
		const registry = new ToolRegistry([
			new TestTool({
				name: "R",
				readOnly: true,
				onStart: (n) => order.push(n),
			}),
		]);
		const bus = new EventBus();
		const hook: LoadedHook = {
			event: "PreToolUse",
			matcher: "R",
			hook: { type: "command", command: "echo {}" },
			source: { kind: "project", path: "settings.json" },
			trusted: true,
			hash: "test-hash",
		};
		const controller = new HookController({
			hooks: [hook],
			bus,
			cwd: process.cwd(),
			sessionId: "sess_test",
		});
		const scheduler = new ToolScheduler(registry, bus, () => true, controller);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		// Hooks are arbitrary user commands: an early run later discarded
		// would fire them twice (or for a call never confirmed), so hooked
		// tools wait for the authoritative list. The planner enforces this
		// by clearing concurrencySafe for tools with matching trusted hooks.
		round.offer(callRef("R"));
		await Bun.sleep(5);
		expect(order).toEqual([]);

		const outputs = await round.finalize([callRef("R")]);
		expect(outputs.length).toBe(1);
		expect(order).toEqual(["R"]);
	});

	it("skips calls the skip predicate rejects", async () => {
		let runs = 0;
		const pendings: string[] = [];
		const bus = new EventBus();
		bus.on("tool:pending", (event) => pendings.push(event.toolCallId));
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true, onStart: () => runs++ }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
			{ skip: (id) => id === "call_R" },
		);

		round.announce("call_R", "R");
		round.offer(callRef("R"));
		await Bun.sleep(5);
		expect(runs).toBe(0);
		expect(pendings).toEqual([]);
	});

	it("announce renders a pending row and offer upgrades it in place", async () => {
		const pendings: Array<{ id: string; summary: string }> = [];
		const bus = new EventBus();
		bus.on("tool:pending", (event) =>
			pendings.push({ id: event.toolCallId, summary: event.inputSummary }),
		);
		const registry = new ToolRegistry([
			new TestTool({ name: "R", readOnly: true }),
		]);
		const scheduler = new ToolScheduler(registry, bus);
		const round = scheduler.createRound(
			makeContext(new AbortController().signal, bus),
		);

		round.announce("call_R", "R");
		expect(pendings).toEqual([{ id: "call_R", summary: "" }]);

		// offer re-emits pending for the same id so the row can upgrade in
		// place once the parsed input (and its summary) is known.
		round.offer(callRef("R", { value: "v" }));
		expect(pendings.length).toBe(2);
		expect(pendings[1]?.id).toBe("call_R");

		await round.finalize([callRef("R", { value: "v" })]);
		// finalize does not re-announce an already-announced call.
		expect(pendings.length).toBe(2);
	});
});

describe("backboard mapper early tool events", () => {
	it("maps tool_call_start frames", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_call_start",
			run_id: "run_1",
			tool_call_id: "call_1",
			name: "web_fetch",
		});
		expect(events).toEqual([
			{ kind: "tool_started", id: "call_1", name: "web_fetch" },
		]);
	});

	it("maps tool_call_ready frames", () => {
		const events = mapStreamPayloadToEvents({
			type: "tool_call_ready",
			run_id: "run_1",
			tool_call: {
				id: "call_1",
				type: "function",
				function: { name: "web_fetch", arguments: '{"url":"https://x"}' },
			},
		});
		expect(events).toEqual([
			{
				kind: "tool_ready",
				call: { id: "call_1", name: "web_fetch", input: { url: "https://x" } },
			},
		]);
	});

	it("drops malformed early tool frames without failing the stream", () => {
		expect(
			mapStreamPayloadToEvents({ type: "tool_call_start", name: "x" }),
		).toEqual([]);
		expect(
			mapStreamPayloadToEvents({ type: "tool_call_ready", tool_call: 42 }),
		).toEqual([]);
	});
});
