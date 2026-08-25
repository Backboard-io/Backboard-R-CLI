import { describe, expect, it } from "bun:test";
import { Semaphore } from "../src/utils/semaphore.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("Semaphore", () => {
	it("rejects non-positive permit counts", () => {
		expect(() => new Semaphore(0)).toThrow();
		expect(() => new Semaphore(1.5)).toThrow();
	});

	it("caps concurrent holders and queues the rest", async () => {
		const semaphore = new Semaphore(2);
		const gates = [deferred(), deferred(), deferred()];
		let active = 0;
		let peak = 0;

		const runs = gates.map((gate) =>
			semaphore.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await gate.promise;
				active--;
			}),
		);

		await Promise.resolve();
		expect(active).toBe(2);

		for (const gate of gates) gate.resolve();
		await Promise.all(runs);
		expect(peak).toBe(2);
	});

	it("releases the permit when the task throws", async () => {
		const semaphore = new Semaphore(1);
		await expect(
			semaphore.run(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(semaphore.run(async () => "ok")).resolves.toBe("ok");
	});

	it("grants queued waiters in FIFO order", async () => {
		const semaphore = new Semaphore(1);
		const order: number[] = [];
		const gate = deferred();

		const first = semaphore.run(async () => {
			order.push(0);
			await gate.promise;
		});
		const rest = [1, 2, 3].map((n) =>
			semaphore.run(async () => {
				order.push(n);
			}),
		);

		gate.resolve();
		await Promise.all([first, ...rest]);
		expect(order).toEqual([0, 1, 2, 3]);
	});
});
