import { describe, expect, it } from "bun:test";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { makeContext } from "./helpers.ts";

describe("ExecuteTool process management", () => {
	it("settles once the shell exits even if a background child holds stdio", async () => {
		const tool = new ExecuteTool();
		const started = Date.now();
		const result = await tool.execute(
			{ command: "sleep 15 & echo started" },
			makeContext(new AbortController().signal),
		);

		expect(result.data.stdout?.trim()).toBe("started");
		expect(result.data.exitCode).toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 10_000);

	it("kills the whole process tree on timeout", async () => {
		const tool = new ExecuteTool();
		const started = Date.now();
		const result = await tool.execute(
			{ command: "sleep 30; echo done", timeout: 1 },
			makeContext(new AbortController().signal),
		);

		expect(result.data.timedOut).toBe(true);
		expect(Date.now() - started).toBeLessThan(5_000);
	}, 10_000);

	it("rejects promptly on abort even after the shell has exited", async () => {
		const tool = new ExecuteTool();
		const controller = new AbortController();
		const pending = tool.execute(
			{ command: "sleep 15 & echo hi" },
			makeContext(controller.signal),
		);

		// Let the shell exit first; only the background child survives.
		await new Promise((r) => setTimeout(r, 500));
		const started = Date.now();
		controller.abort();

		expect(pending).rejects.toThrow();
		await pending.catch(() => {});
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 10_000);
});
