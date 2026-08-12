import { describe, expect, it } from "bun:test";
import { startNewSession } from "../src/ui/utils/startNewSession.ts";

describe("startNewSession", () => {
	it("does not reset the active thread when lifecycle activation fails", async () => {
		let reset = false;

		await expect(
			startNewSession({
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
});
