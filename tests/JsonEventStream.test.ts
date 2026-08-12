import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { JsonEventStream } from "../src/core/session/JsonEventStream.ts";

describe("JsonEventStream", () => {
	it("continues sequence numbers across session activation", () => {
		const writes: string[] = [];
		const originalWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const bus = new EventBus();
			const stream = new JsonEventStream("sess_first");
			stream.attach(bus);
			bus.emit({ type: "system:warning", message: "first" });
			stream.activate("sess_second");
			bus.emit({ type: "system:warning", message: "second" });
			stream.detach();
		} finally {
			process.stdout.write = originalWrite;
		}

		const records = writes.map(
			(line) => JSON.parse(line) as { session_id: string; sequence: number },
		);
		expect(
			records.map(({ session_id, sequence }) => ({ session_id, sequence })),
		).toEqual([
			{ session_id: "sess_first", sequence: 0 },
			{ session_id: "sess_second", sequence: 1 },
		]);
	});
});
