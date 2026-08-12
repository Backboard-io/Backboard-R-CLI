import { describe, expect, it } from "bun:test";
import { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent, ToolCallRef } from "../src/core/bus/events.ts";
import { Session } from "../src/core/session/Session.ts";

const toolCall: ToolCallRef = { id: "call_1", name: "TodoWrite", input: {} };

function makeAccumulator(deps?: {
	suppressFinalMessage?: () => boolean;
	suppressAllMessages?: () => boolean;
}) {
	const bus = new EventBus();
	const session = new Session("sess_test");
	const events: AgentEvent[] = [];
	bus.onAny((event) => events.push(event));
	const accumulator = new AssistantAccumulator("turn_1", bus, session, deps);
	return { accumulator, events, session };
}

function eventTypes(events: AgentEvent[]): string[] {
	return events.map((event) => event.type);
}

describe("AssistantAccumulator", () => {
	it("streams deltas and finalizes into a shown message by default", () => {
		const { accumulator, events, session } = makeAccumulator();
		accumulator.appendDelta("Hello");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:delta",
			"assistant:message",
		]);
		expect(session.getMessages()).toHaveLength(1);
	});

	it("discards a buffered true final answer but shows buffered commentary before tool rounds", () => {
		const buffered = makeAccumulator({ suppressFinalMessage: () => true });
		buffered.accumulator.appendDelta("done");
		buffered.accumulator.finalize();
		expect(eventTypes(buffered.events)).toEqual(["assistant:message:discard"]);
		expect(buffered.session.getMessages()).toHaveLength(1);

		const commentary = makeAccumulator({ suppressFinalMessage: () => true });
		commentary.accumulator.appendDelta("on it");
		commentary.accumulator.finalize([toolCall]);
		expect(eventTypes(commentary.events)).toEqual(["assistant:message"]);
	});

	it("hides a suppressed exchange entirely, even when tool calls follow", () => {
		const { accumulator, events, session } = makeAccumulator({
			suppressAllMessages: () => true,
		});
		accumulator.appendDelta("Updating the plan");
		accumulator.finalize([toolCall]);
		accumulator.appendDelta("Plan is up-to-date.");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:message:discard",
			"assistant:message:discard",
		]);
		// Hidden text still lands in the session so the model keeps its own
		// words in context.
		expect(session.getMessages()).toHaveLength(2);
	});

	it("evaluates suppression per segment, so hiding ends with the exchange", () => {
		let hide = true;
		const { accumulator, events } = makeAccumulator({
			suppressAllMessages: () => hide,
		});
		accumulator.appendDelta("hidden reply");
		accumulator.finalize();
		hide = false;
		accumulator.appendDelta("visible reply");
		accumulator.finalize();

		expect(eventTypes(events)).toEqual([
			"assistant:message:discard",
			"assistant:delta",
			"assistant:message",
		]);
	});
});
