import { describe, expect, it } from "bun:test";
import { startNewSession } from "../src/ui/utils/startNewSession.ts";

describe("startNewSession", () => {
	it("does not reset the active thread when lifecycle activation fails", async () => {
		let reset = false;

		await expect(
			startNewSession({
				detach: async () => {},
				activate: async () => {
					throw new Error("session init failed");
				},
				resetThread: () => {
					reset = true;
				},
			}),
		).rejects.toThrow("session init failed");

		expect(reset).toBe(false);
	});

	it("detaches the outgoing session before activation rotates storage", async () => {
		const order: string[] = [];

		await startNewSession({
			detach: async () => {
				order.push("detach");
			},
			activate: async () => {
				order.push("activate");
			},
			resetThread: () => order.push("resetThread"),
		});

		expect(order).toEqual(["detach", "activate", "resetThread"]);
	});
});
