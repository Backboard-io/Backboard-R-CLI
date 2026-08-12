import type React from "react";
import {
	sortThreadsByUpdatedAt,
	threadDisplayTitle,
	threadMessageCount,
	threadUpdatedAt,
	truncate,
} from "../../providers/backboard/threads.ts";
import type { BackboardThread } from "../../providers/backboard/types.ts";
import { formatClockTime } from "../../utils/time.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

interface Props {
	threads: BackboardThread[];
	onSelect: (thread: BackboardThread) => void | Promise<void>;
	onCancel: () => void;
}

export function SessionsSelector({
	threads,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title="Sessions"
			tabs={sessionTabs(threads)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No sessions found."
		/>
	);
}

function sessionTabs(
	threads: readonly BackboardThread[],
): PickerTab<BackboardThread>[] {
	return [
		{
			id: "sessions",
			label: "Sessions",
			items: sortThreadsByUpdatedAt(threads).map((thread) => ({
				id: thread.thread_id,
				name: compactSessionTitle(threadDisplayTitle(thread)),
				description: formatUpdatedAt(threadUpdatedAt(thread)) ?? "",
				badge: sessionMessageCount(thread),
				value: thread,
			})),
		},
	];
}

function sessionMessageCount(thread: BackboardThread): string {
	const count = threadMessageCount(thread);
	return `${count} msg`;
}

function formatUpdatedAt(value: string | null): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${month}/${day}, ${formatClockTime(date)} ${timeZoneLabel(value, date)}`;
}

function timeZoneLabel(value: string, date: Date): string {
	if (!hasTimezoneOffset(value)) return "UTC";
	const label = new Intl.DateTimeFormat(undefined, {
		timeZoneName: "short",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;
	return label ?? "";
}

function hasTimezoneOffset(value: string): boolean {
	return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function compactSessionTitle(title: string): string {
	return truncate(title, 48);
}
