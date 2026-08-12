import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo } from "react";
import type {
	HookEventName,
	HookEventSummary,
	HookManagerSnapshot,
} from "../../core/hooks/index.ts";
import { pluralize } from "../../utils/string.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { HintFooter } from "./HintFooter.tsx";
import { HookPanel } from "./HookShared.tsx";
import { SelectRow } from "./SelectRow.tsx";

export interface HookManagerSelection {
	type: "event";
	event: HookEventSummary;
}

interface Props {
	snapshot: HookManagerSnapshot;
	onSelect: (selection: HookManagerSelection) => void;
	onCancel: () => void;
}

interface HookManagerItem {
	id: string;
	event: HookEventSummary;
}

const EVENT_ORDER: readonly HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionStart",
	"Stop",
	"SessionEnd",
];

export function HookManagerSelector({
	snapshot,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	const items = useMemo(() => hookManagerItems(snapshot), [snapshot]);
	const selection = useListSelection(items.length, { digitJump: true });
	const selected =
		items[Math.min(selection.index, Math.max(0, items.length - 1))];

	useInput((input, key) => {
		if (key.escape || input.toLowerCase() === "q") {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (key.return && selected) {
			onSelect({ type: "event", event: selected.event });
		}
	});

	return (
		<HookPanel>
			<Text color={theme.subtle}>
				{snapshot.hooks.length} {pluralize(snapshot.hooks.length, "hook")}{" "}
				configured
			</Text>
			<Box marginTop={1}>
				<Text color={theme.subtle}>
					Open an event to add or remove personal hooks.
				</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				{items.map((item, index) => (
					<HookManagerRow
						key={item.id}
						index={index}
						item={item}
						selected={item === selected}
					/>
				))}
			</Box>
			<HintFooter hints={["Enter open", "Esc cancel"]} />
		</HookPanel>
	);
}

function HookManagerRow({
	index,
	item,
	selected,
}: {
	index: number;
	item: HookManagerItem;
	selected: boolean;
}): React.ReactElement {
	return (
		<SelectRow selected={selected}>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{`${index + 1}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{eventNameLabel(item.event)}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{" "}
				{item.event.description}
			</Text>
		</SelectRow>
	);
}

function eventNameLabel(event: HookEventSummary): string {
	return event.total > 0 ? `${event.event} (${event.total})` : event.event;
}

function hookManagerItems(snapshot: HookManagerSnapshot): HookManagerItem[] {
	const byEvent = new Map(snapshot.events.map((event) => [event.event, event]));
	// Append events not in EVENT_ORDER so a new event never disappears.
	const ordered = [
		...EVENT_ORDER,
		...snapshot.events
			.map((event) => event.event)
			.filter((name) => !EVENT_ORDER.includes(name)),
	];
	return ordered
		.map((eventName) => byEvent.get(eventName))
		.filter((event): event is HookEventSummary => Boolean(event))
		.map((event) => ({
			id: event.event,
			event,
		}));
}
