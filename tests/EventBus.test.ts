import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";

describe("EventBus", () => {
	it("delivers typed events to matching listeners", () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.on("user:message", (e) => seen.push(e.text));
		bus.emit({ type: "user:message", text: "hello" });
		bus.emit({ type: "turn:start", turnId: "t1" });
		expect(seen).toEqual(["hello"]);
	});

	it("delivers every event to onAny in order", () => {
		const bus = new EventBus();
		const types: AgentEvent["type"][] = [];
		bus.onAny((e) => types.push(e.type));
		bus.emit({ type: "turn:start", turnId: "t1" });
		bus.emit({
			type: "turn:end",
			turnId: "t1",
			status: "completed",
			durationMs: 0,
		});
		expect(types).toEqual(["turn:start", "turn:end"]);
	});

	it("unsubscribes correctly", () => {
		const bus = new EventBus();
		let count = 0;
		const off = bus.on("turn:start", () => count++);
		bus.emit({ type: "turn:start", turnId: "t1" });
		off();
		bus.emit({ type: "turn:start", turnId: "t2" });
		expect(count).toBe(1);
	});

	it("isolates listener errors", () => {
		const bus = new EventBus();
		let reached = false;
		bus.onAny(() => {
			throw new Error("boom");
		});
		bus.onAny(() => {
			reached = true;
		});
		bus.emit({ type: "turn:start", turnId: "t1" });
		expect(reached).toBe(true);
	});
});
