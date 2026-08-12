import { describe, expect, it } from "bun:test";
import {
	parseSseFrame,
	readSseFrames,
	splitSseFrames,
} from "../src/providers/backboard/sse.ts";

describe("SSE helpers", () => {
	it("splits complete frames and keeps partial rest", () => {
		expect(splitSseFrames("data: 1\n\ndata: 2\n\ndata: 3")).toEqual({
			frames: ["data: 1", "data: 2"],
			rest: "data: 3",
		});
	});

	it("parses multiline data frames", () => {
		expect(parseSseFrame('event: message\ndata: {"a":\ndata: 1}\n')).toEqual({
			a: 1,
		});
	});

	it("reads frames across stream chunks", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				controller.enqueue(encoder.encode("data: 1\n\nda"));
				controller.enqueue(encoder.encode("ta: 2\n\n"));
				controller.close();
			},
		});

		const frames: string[] = [];
		for await (const frame of readSseFrames(body)) {
			frames.push(frame);
		}

		expect(frames).toEqual(["data: 1", "data: 2"]);
	});

	it("does not cancel the reader after natural EOF", async () => {
		let cancelCount = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
				controller.close();
			},
			cancel() {
				cancelCount++;
			},
		});

		const frames: string[] = [];
		for await (const frame of readSseFrames(body)) {
			frames.push(frame);
		}

		expect(frames).toEqual(["data: 1"]);
		expect(cancelCount).toBe(0);
	});

	it("cancels the reader when iteration stops early", async () => {
		let cancelCount = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: 1\n\ndata: 2\n\n"));
			},
			cancel() {
				cancelCount++;
			},
		});

		for await (const _frame of readSseFrames(body)) {
			break;
		}

		expect(cancelCount).toBe(1);
	});
});
