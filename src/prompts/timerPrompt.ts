import {
	TIMER_REMINDER_CLOSE,
	TIMER_REMINDER_OPEN,
} from "./timer.constants.ts";

export function formatTimerDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 120 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}

export function timerReminder(lines: readonly string[]): string {
	return `${TIMER_REMINDER_OPEN}\n${lines.join(" ")}\n${TIMER_REMINDER_CLOSE}`;
}

/** Per-turn context belongs on the message, not the reusable system prefix. */
export function timerBudgetPrompt(seconds: number): string {
	return timerReminder([
		`## Time budget\n\nYou are allocated ${formatTimerDuration(seconds * 1000)} for this turn. Plan and allocate your time accordingly to fully complete the task end to end.`,
		"The CLI reports this budget but does not stop execution; an external harness may enforce a hard deadline.",
		"When you plan with TodoWrite, give each step a `timeBudgetSeconds`. They should add up to no more than the time still remaining when you write the plan, which is less than the full budget.",
		"Brief notices will report the time remaining and how each step went against your own plan; they need no reply.",
	]);
}

export function timerNotice(remainingMs: number, totalMs: number): string {
	return timerReminder([
		`Time check: ${formatTimerDuration(remainingMs)} of the ${formatTimerDuration(totalMs)} budget remains. No reply needed.`,
	]);
}

export function todoOvercommitNotice(
	plannedMs: number,
	remainingMs: number,
): string {
	return `Your steps allot ${formatTimerDuration(plannedMs)} but ${formatTimerDuration(remainingMs)} remains.`;
}

export function todoStepNotice(
	finished: boolean,
	tookMs: number,
	plannedMs: number | undefined,
): string {
	const subject = finished ? "Previous step" : "The step you moved off";
	return plannedMs === undefined
		? `${subject} took ${formatTimerDuration(tookMs)}.`
		: `${subject}: planned ${formatTimerDuration(plannedMs)}, took ${formatTimerDuration(tookMs)}.`;
}

export function todoProgressNotice(
	done: number,
	count: number,
	remainingMs: number,
	totalMs: number,
	aheadMs: number,
): string {
	return `${done}/${count} steps done. ${formatTimerDuration(remainingMs)} of the ${formatTimerDuration(totalMs)} budget remains; remaining steps are allotted ${formatTimerDuration(aheadMs)}. No reply needed.`;
}
