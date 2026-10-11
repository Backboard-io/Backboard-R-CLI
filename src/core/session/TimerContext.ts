import {
	TIMER_REMINDER_CLOSE,
	TIMER_REMINDER_OPEN,
} from "../../prompts/timer.constants.ts";

/** Remove only our tagged leading budget, never a general system reminder. */
export function withoutTimerPrefix(content: string): string {
	if (!content.startsWith(`${TIMER_REMINDER_OPEN}\n`)) return content;
	const end = content.indexOf(`\n${TIMER_REMINDER_CLOSE}\n\n`);
	return end < 0
		? content
		: content.slice(end + TIMER_REMINDER_CLOSE.length + 3);
}

/** Provider history retains model context; resume rendering drops our suffixes. */
export function withoutTimerSuffix(content: string): string {
	const open = `\n\n${TIMER_REMINDER_OPEN}\n`;
	const close = `\n${TIMER_REMINDER_CLOSE}`;
	// A round appends at most one clock notice and one todo notice.
	for (let i = 0; i < 2 && content.endsWith(close); i++) {
		const start = content.lastIndexOf(open);
		if (start < 0) break;
		const body = content.slice(start + open.length, -close.length);
		if (body.includes(TIMER_REMINDER_CLOSE)) break;
		content = content.slice(0, start);
	}
	return content;
}
