import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import { parseFlags } from "../src/config/flags.ts";
import { parseTimerSeconds } from "../src/config/timer.ts";
import {
	canRunCommandAfterSessionEnd,
	parseCommand,
	slashCommandSuggestions,
} from "../src/ui/commands/index.ts";

const env = { apiKey: "test", apiUrl: "https://example.test/api" };
const homes: string[] = [];
afterEach(async () => {
	await Promise.all(
		homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
	);
});

describe("timer configuration", () => {
	it("supports both flag forms and explicit disable overrides", () => {
		expect(new Config({ env, argv: [] }).timerSeconds).toBeUndefined();
		for (const argv of [["--timer", "900"], ["--timer=900"]]) {
			expect(new Config({ env, argv }).timerSeconds).toBe(900);
		}
		for (const value of ["off", "OFF", "0"]) {
			expect(parseTimerSeconds(value, 900)).toBeUndefined();
		}
		expect(parseTimerSeconds(undefined, 900)).toBe(900);
		expect(parseFlags(["--timer", "900", "--no-timer"]).timer).toBe("off");
		expect(parseFlags(["--no-timer", "--timer=60"]).timer).toBe("60");
	});

	it("rejects missing, fractional, negative, and non-finite budgets", () => {
		for (const value of [
			"",
			"soon",
			"-5",
			"0.1",
			"1.5",
			"NaN",
			"Infinity",
			"1e300",
		]) {
			expect(() => parseTimerSeconds(value)).toThrow("--timer");
		}
		expect(() => new Config({ env, argv: ["--timer"] })).toThrow("--timer");
	});

	it("persists runtime changes without letting flags overwrite preferences", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "timer-config-"));
		homes.push(homeDir);
		await saveBackboardConfig({ timerSeconds: 900, notify: true }, homeDir);
		const config = new Config({ env, homeDir, argv: ["--no-timer"] });
		expect(config.timerSeconds).toBeUndefined();
		await config.saveRuntimeSelection();
		expect(readBackboardConfig(homeDir).timerSeconds).toBe(900);
		config.setTimerSeconds(120);
		await config.saveTimerPreference();
		expect(new Config({ env, homeDir, argv: [] }).timerSeconds).toBe(120);
		expect(readBackboardConfig(homeDir).notify).toBe(true);
		config.setTimerSeconds(undefined);
		await config.saveTimerPreference();
		expect(new Config({ env, homeDir, argv: [] }).timerSeconds).toBeUndefined();
		expect(() => config.setTimerSeconds(0.5)).toThrow();
	});

	it("ignores invalid saved budgets", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "timer-config-"));
		homes.push(homeDir);
		for (const timerSeconds of [-1, 0, 0.5, Number.MAX_VALUE]) {
			await saveBackboardConfig({ timerSeconds }, homeDir);
			expect(readBackboardConfig(homeDir).timerSeconds).toBeUndefined();
		}
	});
});

describe("/timer", () => {
	it("sets, clears, and appears in suggestions", () => {
		expect(parseCommand("/timer 900")).toEqual({ type: "timer", seconds: 900 });
		for (const command of ["/timer", "/timer off", "/timer 0"]) {
			expect(parseCommand(command)).toEqual({ type: "timer", seconds: null });
		}
		expect(slashCommandSuggestions("/timer")[0]?.type).toBe("timer");
		expect(canRunCommandAfterSessionEnd("timer")).toBe(true);
	});

	it("rejects bad input rather than silently clearing an existing budget", () => {
		for (const value of ["soon", "-1", "0.5", "60 extra", "Infinity"]) {
			expect(parseCommand(`/timer ${value}`)).toMatchObject({
				type: "timer",
				error: expect.any(String),
			});
		}
	});
});
