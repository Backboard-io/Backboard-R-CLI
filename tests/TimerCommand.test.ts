import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import { handleTimerCommand } from "../src/ui/commands/timer.ts";

const homes: string[] = [];
const env = { apiKey: "test", apiUrl: "https://example.test/api" };
afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

describe("interactive timer commands", () => {
	it("clears a saved timer even when a CLI override already disabled it", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "timer-command-"));
		homes.push(homeDir);
		await saveBackboardConfig({ timerSeconds: 900, notify: true }, homeDir);
		const config = new Config({ env, homeDir, argv: ["--no-timer"] });
		expect(config.timerSeconds).toBeUndefined();
		const notices: string[] = [];
		await handleTimerCommand({ type: "timer", seconds: null }, config, (text) =>
			notices.push(text),
		);
		expect(readBackboardConfig(homeDir).timerSeconds).toBeUndefined();
		expect(readBackboardConfig(homeDir).notify).toBe(true);
		expect(notices).toContain("Time budget cleared for subsequent turns.");
	});

	it("reports persistence errors without rejecting the command", async () => {
		const config = new Config({ env, argv: [] });
		const save = spyOn(config, "saveTimerPreference").mockRejectedValue(
			new Error("disk unavailable"),
		);
		const notices: Array<[string, string | undefined]> = [];
		try {
			await handleTimerCommand(
				{ type: "timer", seconds: 60 },
				config,
				(text, level) => notices.push([text, level]),
			);
			expect(config.timerSeconds).toBe(60);
			expect(notices).toContainEqual([
				"Failed to save timer preference: disk unavailable",
				"error",
			]);
		} finally {
			save.mockRestore();
		}
	});

	it("keeps the current timer when the command is invalid", async () => {
		const config = new Config({ env, argv: ["--timer", "900"] });
		const save = spyOn(config, "saveTimerPreference").mockResolvedValue();
		try {
			await handleTimerCommand(
				{ type: "timer", seconds: null, error: "Invalid budget" },
				config,
				() => {},
			);
			expect(config.timerSeconds).toBe(900);
			expect(save).not.toHaveBeenCalled();
		} finally {
			save.mockRestore();
		}
	});
});
