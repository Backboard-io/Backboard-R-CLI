import { timerNotice } from "../../../prompts/timerPrompt.ts";
import { TIMER_THRESHOLDS } from "./constants.ts";

/** Advisory wall-clock budget. One instance per turn; never cancels work. */
export class TurnTimer {
	private readonly fired = new Set<number>();

	constructor(
		readonly totalBudgetMs: number,
		private readonly startedAt: number,
	) {}

	remainingMs(now = Date.now()): number {
		return Math.max(0, this.startedAt + this.totalBudgetMs - now);
	}

	nextReminder(now = Date.now()): string | null {
		if (this.totalBudgetMs <= 0) return null;
		const fraction = this.remainingMs(now) / this.totalBudgetMs;
		// A slow round can cross several thresholds. Report only the latest.
		const crossed = TIMER_THRESHOLDS.findLast(
			(threshold) => fraction <= threshold,
		);
		if (crossed === undefined || this.fired.has(crossed)) return null;
		return this.reportNow(now);
	}

	/** A running command has just returned control; waiting needs a fresh clock. */
	reportNow(now = Date.now()): string | null {
		if (this.totalBudgetMs <= 0) return null;
		const remaining = this.remainingMs(now);
		for (const threshold of TIMER_THRESHOLDS) {
			if (remaining / this.totalBudgetMs <= threshold)
				this.fired.add(threshold);
		}
		return timerNotice(remaining, this.totalBudgetMs);
	}
}
