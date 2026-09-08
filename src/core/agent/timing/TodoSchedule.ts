import {
	timerReminder,
	todoOvercommitNotice,
	todoProgressNotice,
	todoStepNotice,
} from "../../../prompts/timerPrompt.ts";
import type { TodoItem } from "../../bus/events.ts";
import { MIN_PLAN_SLACK_MS, PLAN_SLACK_FRACTION } from "./constants.ts";
import type { TurnTimer } from "./TurnTimer.ts";

/** Factual progress against the agent's own allocations, not scheduling policy. */
export class TodoSchedule {
	private activeId?: string;
	private activeStartedAt?: number;
	private activeBudgetMs?: number;
	private overcommitReported = false;

	private forgetActive(): void {
		this.activeId = undefined;
		this.activeStartedAt = undefined;
		this.activeBudgetMs = undefined;
	}

	onUpdate(
		todos: readonly TodoItem[],
		timer: TurnTimer | undefined,
		now = Date.now(),
	): string | null {
		if (!timer || todos.length === 0) {
			this.forgetActive();
			return null;
		}
		const active = todos.find((todo) => todo.status === "in_progress");
		const changed = this.activeId !== undefined && active?.id !== this.activeId;
		const previous = changed
			? todos.find((todo) => todo.id === this.activeId)
			: undefined;
		const tookMs =
			changed && this.activeStartedAt !== undefined
				? now - this.activeStartedAt
				: undefined;
		const plannedMs = changed ? this.activeBudgetMs : undefined;

		// Re-arm even for unbudgeted replans, so a later report cannot span
		// abandoned steps. Preserve the original allowance while a step runs.
		if (changed) this.forgetActive();
		if (active && this.activeId === undefined) {
			this.activeId = active.id;
			this.activeStartedAt = now;
			this.activeBudgetMs =
				active.timeBudgetSeconds === undefined
					? undefined
					: active.timeBudgetSeconds * 1000;
		}
		if (!todos.some((todo) => todo.timeBudgetSeconds !== undefined))
			return null;

		const remainingMs = timer.remainingMs(now);
		const aheadMs = todos
			.filter((todo) => todo.status !== "completed")
			.reduce((sum, todo) => sum + (todo.timeBudgetSeconds ?? 0) * 1000, 0);
		const lines: string[] = [];
		const slackMs = Math.max(
			MIN_PLAN_SLACK_MS,
			timer.totalBudgetMs * PLAN_SLACK_FRACTION,
		);
		if (!this.overcommitReported && aheadMs > remainingMs + slackMs) {
			this.overcommitReported = true;
			lines.push(todoOvercommitNotice(aheadMs, remainingMs));
		}
		if (tookMs !== undefined) {
			lines.push(
				todoStepNotice(previous?.status === "completed", tookMs, plannedMs),
			);
		}
		if (lines.length === 0) return null;
		lines.push(
			todoProgressNotice(
				todos.filter((todo) => todo.status === "completed").length,
				todos.length,
				remainingMs,
				timer.totalBudgetMs,
				aheadMs,
			),
		);
		return timerReminder(lines);
	}
}
