import { describe, expect, it } from "bun:test";
import {
	type QueuedSubmit,
	SUBMIT_PRIORITY_ORDER,
	type SubmitPriority,
} from "../src/core/agent/AgentControllerTypes.ts";

/**
 * Mirrors AgentController.takeNextSubmit. The controller needs a live client to
 * drain for real, so the selection rule is exercised directly — it is the part
 * that decides whether background reports can starve the user.
 */
function takeNext(queue: QueuedSubmit[]): QueuedSubmit | undefined {
	let bestIndex = -1;
	let bestRank = Number.POSITIVE_INFINITY;
	for (const [index, queued] of queue.entries()) {
		const rank = SUBMIT_PRIORITY_ORDER[queued.priority];
		if (rank < bestRank) {
			bestIndex = index;
			bestRank = rank;
		}
	}
	if (bestIndex === -1) return undefined;
	return queue.splice(bestIndex, 1)[0];
}

function queued(text: string, priority: SubmitPriority): QueuedSubmit {
	return {
		text,
		priority,
		emitUserMessage: false,
		resolve: () => {},
		reject: () => {},
	};
}

function drain(queue: QueuedSubmit[]): string[] {
	const order: string[] = [];
	let next = takeNext(queue);
	while (next) {
		order.push(next.text);
		next = takeNext(queue);
	}
	return order;
}

describe("submit priority", () => {
	it("orders now before next before later", () => {
		const queue = [
			queued("report", "later"),
			queued("user", "next"),
			queued("steer", "now"),
		];
		expect(drain(queue)).toEqual(["steer", "user", "report"]);
	});

	it("keeps FIFO within a tier", () => {
		const queue = [
			queued("first", "next"),
			queued("second", "next"),
			queued("third", "next"),
		];
		expect(drain(queue)).toEqual(["first", "second", "third"]);
	});

	it("never lets queued reports starve later user input", () => {
		// Reports land first; the user then types. The user must still go next.
		const queue = [
			queued("report-a", "later"),
			queued("report-b", "later"),
			queued("user", "next"),
		];
		expect(takeNext(queue)?.text).toBe("user");
	});

	it("lets a steer preempt a queue that already holds a report", () => {
		const queue = [queued("report", "later"), queued("steer", "now")];
		expect(takeNext(queue)?.text).toBe("steer");
	});

	it("returns undefined for an empty queue", () => {
		expect(takeNext([])).toBeUndefined();
	});
});
