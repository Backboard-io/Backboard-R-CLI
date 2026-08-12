import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo } from "react";
import type {
	HookEventName,
	HookEventSummary,
	HookManagerSnapshot,
	LoadedHook,
} from "../../core/hooks/index.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { HintFooter } from "./HintFooter.tsx";
import { AddHookRow, HookPanel, hookHelpLines } from "./HookShared.tsx";
import { SelectRow } from "./SelectRow.tsx";

export type HookEventSelection = {
	type: "matcher";
	event: HookEventName;
	matcher: string;
	hooks: LoadedHook[];
};

interface Props {
	event: HookEventSummary;
	snapshot: HookManagerSnapshot;
	onSelect: (selection: HookEventSelection) => void;
	onAddHook: (event: HookEventName) => void;
	onCancel: () => void;
}

interface HookEventItem {
	id: string;
	matcher: string;
	hooks: LoadedHook[];
}

type HookEventRowItem =
	| { kind: "add"; id: string }
	| { kind: "matcher"; id: string; item: HookEventItem };

export function HookEventSelector({
	event,
	snapshot,
	onSelect,
	onAddHook,
	onCancel,
}: Props): React.ReactElement {
	const matchers = useMemo(
		() => hookEventItems(event, snapshot),
		[event, snapshot],
	);
	const rows = useMemo<HookEventRowItem[]>(
		() => [
			{ kind: "add", id: "add-top" },
			...matchers.map((item) => ({
				kind: "matcher" as const,
				id: item.id,
				item,
			})),
		],
		[matchers],
	);
	const selection = useListSelection(rows.length);
	const safeIndex = Math.min(selection.index, Math.max(0, rows.length - 1));
	const selected = rows[safeIndex];

	useInput((input, key) => {
		if (key.escape || input.toLowerCase() === "q") {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (/^[1-9]$/.test(input)) {
			// Digits address matcher rows, offset past the leading "add" row.
			const matcherIndex = Number(input) - 1;
			if (matcherIndex < matchers.length) selection.setIndex(matcherIndex + 1);
			return;
		}
		if (key.return && selected) {
			if (selected.kind === "add") {
				onAddHook(event.event);
				return;
			}
			onSelect({
				type: "matcher",
				event: event.event,
				matcher: selected.item.matcher,
				hooks: selected.item.hooks,
			});
		}
	});

	return (
		<HookPanel title={`${event.event} - ${matcherLabel(event.event)}`}>
			<Box marginTop={1}>
				<HookEventHelp event={event.event} />
			</Box>
			<Box flexDirection="column" marginTop={1}>
				{rows.map((row, index) =>
					row.kind === "add" ? (
						<AddHookRow key={row.id} selected={index === safeIndex} />
					) : (
						<HookEventRow
							key={row.id}
							matcherNumber={matcherDisplayNumber(rows, index)}
							item={row.item}
							selected={index === safeIndex}
						/>
					),
				)}
			</Box>
			<HintFooter hints={["Enter confirm", "Esc cancel"]} />
		</HookPanel>
	);
}

function matcherDisplayNumber(
	rows: readonly HookEventRowItem[],
	index: number,
): number {
	return (
		rows.slice(0, index).filter((row) => row.kind === "matcher").length + 1
	);
}

function HookEventRow({
	matcherNumber,
	item,
	selected,
}: {
	matcherNumber: number;
	item: HookEventItem;
	selected: boolean;
}): React.ReactElement {
	const hookLabel = item.hooks.length === 1 ? "hook" : "hooks";
	return (
		<SelectRow selected={selected}>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{`${matcherNumber}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{item.matcher}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{"  "}
				{item.hooks.length} {hookLabel}
			</Text>
		</SelectRow>
	);
}

function hookEventItems(
	event: HookEventSummary,
	snapshot: HookManagerSnapshot,
): HookEventItem[] {
	const groups = new Map<string, LoadedHook[]>();
	for (const hook of snapshot.hooks) {
		if (hook.event !== event.event) continue;
		const matcher = hook.matcher ?? "*";
		groups.set(matcher, [...(groups.get(matcher) ?? []), hook]);
	}

	const matchers = [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([matcher, hooks]) => ({
			id: `matcher:${matcher}`,
			matcher,
			hooks,
		}));
	return matchers;
}

function matcherLabel(event: HookEventName): string {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
			return "Tool Matchers";
		case "SessionStart":
			return "Session Matchers";
		case "UserPromptSubmit":
			return "Prompt Matchers";
		case "Stop":
		case "SessionEnd":
			return "Triggers";
	}
}

function HookEventHelp({
	event,
}: {
	event: HookEventName;
}): React.ReactElement {
	const lines = hookHelpLines(event);
	return (
		<Box flexDirection="column">
			{lines.map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
		</Box>
	);
}
