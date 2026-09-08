import { describe, expect, it } from "bun:test";
import {
	withoutTimerPrefix,
	withoutTimerSuffix,
} from "../src/core/session/TimerContext.ts";
import { timerBudgetPrompt, timerNotice } from "../src/prompts/timerPrompt.ts";

describe("timer context display filtering", () => {
	it("removes only a complete tagged leading budget", () => {
		const prompt = timerBudgetPrompt(60);
		expect(withoutTimerPrefix(`${prompt}\n\nhello`)).toBe("hello");
		expect(withoutTimerPrefix(`${prompt}\n\n`)).toBe("");
		expect(withoutTimerPrefix(prompt)).toBe(prompt);
		expect(withoutTimerPrefix(`hello\n\n${prompt}`)).toBe(`hello\n\n${prompt}`);
	});

	it("keeps unrelated, incomplete, and non-trailing tool content", () => {
		const note = timerNotice(60_000, 120_000);
		for (const content of [
			"output\n\n<system-reminder>not ours</system-reminder>",
			`output\n\n${note}\nmore output`,
			`output\n\n${note.slice(0, -5)}`,
		]) {
			expect(withoutTimerSuffix(content)).toBe(content);
		}
		expect(withoutTimerSuffix(`\n\n${note}`)).toBe("");
		expect(withoutTimerSuffix(`Error: failed\n\n${note}`)).toBe(
			"Error: failed",
		);
	});
});
