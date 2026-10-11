import { describe, expect, it } from "bun:test";
import { TurnTimer } from "../src/core/agent/timing/TurnTimer.ts";
import { formatTimerDuration } from "../src/prompts/timerPrompt.ts";

const START = 1_000_000;
const BUDGET = 900_000;
const at = (remaining: number) => START + BUDGET * (1 - remaining);

describe("TurnTimer", () => {
	it("is inert with no budget and silent before halfway", () => {
		expect(new TurnTimer(0, START).nextReminder(at(0))).toBeNull();
		const timer = new TurnTimer(BUDGET, START);
		for (const remaining of [1, 0.9, 0.51]) {
			expect(timer.nextReminder(at(remaining))).toBeNull();
		}
	});

	it("reports each threshold once using the actual clock", () => {
		const timer = new TurnTimer(BUDGET, START);
		for (const [remaining, text] of [
			[0.5, "7m"],
			[0.25, "3m"],
			[0.1, "90s"],
		] as const) {
			expect(timer.nextReminder(at(remaining))).toContain(
				`Time check: ${text} of the 15m`,
			);
			expect(timer.nextReminder(at(remaining) + 1)).toBeNull();
		}
	});

	it("skips obsolete thresholds after a long tool round", () => {
		const timer = new TurnTimer(BUDGET, START);
		expect(timer.nextReminder(at(0.12))).toContain("108s");
		expect(timer.nextReminder(at(0.11))).toBeNull();
		expect(timer.nextReminder(at(0.08))).toContain("72s");
		expect(timer.nextReminder(at(0))).toBeNull();
	});

	it("reports zero, never negative, when the first round exceeds the budget", () => {
		const timer = new TurnTimer(BUDGET, START);
		expect(timer.nextReminder(at(0) + 1000)).toContain("0s of the 15m");
		expect(timer.nextReminder(at(0) + 2000)).toBeNull();
	});

	it("forced reports consume crossed thresholds without suppressing future ones", () => {
		const timer = new TurnTimer(BUDGET, START);
		expect(timer.reportNow(at(0.8))).toContain("12m");
		expect(timer.nextReminder(at(0.5))).toContain("7m");
		expect(timer.reportNow(at(0.2))).toContain("3m");
		expect(timer.nextReminder(at(0.19))).toBeNull();
		expect(timer.nextReminder(at(0.1))).toContain("90s");
	});

	it("uses independent state for subsequent turns", () => {
		new TurnTimer(BUDGET, START).nextReminder(at(0));
		const next = new TurnTimer(BUDGET, at(0));
		expect(next.remainingMs(at(0))).toBe(BUDGET);
		expect(next.nextReminder(at(0))).toBeNull();
		expect(next.nextReminder(at(0) + BUDGET / 2)).toContain("7m");
	});

	it("rounds down and uses seconds below two minutes", () => {
		expect(
			[0, -1, 119_999, 120_000, 179_999, 900_000].map(formatTimerDuration),
		).toEqual(["0s", "0s", "119s", "2m", "2m", "15m"]);
	});
});
