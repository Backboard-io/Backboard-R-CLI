import { Box, Text, useInput } from "ink";
import type React from "react";
import type { HookEventName, LoadedHook } from "../../core/hooks/index.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { withStableKeys } from "../utils/stableKeys.ts";
import { HintFooter } from "./HintFooter.tsx";
import {
	AddHookRow,
	DeleteConfirmationStatus,
	HookPanel,
	hookHelpLines,
	useDeleteConfirmation,
} from "./HookShared.tsx";
import { SelectRow } from "./SelectRow.tsx";

interface Props {
	event: HookEventName;
	matcher: string;
	hooks: LoadedHook[];
	onSelect: (hook: LoadedHook) => void;
	onAddHook: (event: HookEventName, matcher: string) => void;
	onDelete?: (hook: LoadedHook) => Promise<void>;
	onCancel: () => void;
}

type HookMatcherRow =
	| { kind: "add"; id: string }
	| { kind: "hook"; id: string; hook: LoadedHook; number: number };

export function HookMatcherSelector({
	event,
	matcher,
	hooks,
	onSelect,
	onAddHook,
	onDelete,
	onCancel,
}: Props): React.ReactElement {
	const deletion = useDeleteConfirmation(onDelete);
	const keyed = withStableKeys(hooks, hookKey);
	const rows: HookMatcherRow[] = [
		{ kind: "add", id: "add-top" },
		...keyed.map((entry, index) => ({
			kind: "hook" as const,
			id: entry.key,
			hook: entry.item,
			number: index + 1,
		})),
	];
	const selection = useListSelection(rows.length);
	const safeSelectedIndex = Math.min(
		selection.index,
		Math.max(0, rows.length - 1),
	);
	const selectedRow = rows[safeSelectedIndex];
	const selectedHook =
		selectedRow?.kind === "hook" ? selectedRow.hook : undefined;

	useInput((input, key) => {
		if (deletion.deleting) return;
		if (deletion.confirming) {
			if (input.toLowerCase() === "y") {
				if (selectedHook) deletion.performDelete(selectedHook);
				else deletion.cancelConfirm();
				return;
			}
			if (key.escape || input.toLowerCase() === "n") {
				deletion.cancelConfirm();
				return;
			}
			return;
		}
		if (key.escape || input.toLowerCase() === "q") {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (/^[1-9]$/.test(input)) {
			// Digits address hook rows, offset past the leading "add" row.
			const hookIndex = Number(input) - 1;
			if (hookIndex < hooks.length) selection.setIndex(hookIndex + 1);
			return;
		}
		if (input.toLowerCase() === "d") {
			if (deletion.canDelete && selectedHook) deletion.requestConfirm();
			return;
		}
		if (key.return && selectedRow) {
			if (selectedRow.kind === "add") {
				onAddHook(event, matcher);
				return;
			}
			onSelect(selectedRow.hook);
		}
	});

	return (
		<HookPanel title={`${event} - Matcher: ${matcher}`}>
			<Box marginTop={1}>
				<HookHelp event={event} />
			</Box>
			<Box flexDirection="column">
				{rows.map((row, index) =>
					row.kind === "add" ? (
						<AddHookRow key={row.id} selected={index === safeSelectedIndex} />
					) : (
						<HookRow
							key={row.id}
							hook={row.hook}
							number={row.number}
							selected={index === safeSelectedIndex}
						/>
					),
				)}
			</Box>
			<DeleteConfirmationStatus hook={selectedHook} state={deletion} />
			<HintFooter
				hints={["Enter view/add", "d delete (personal)", "Esc back"]}
			/>
		</HookPanel>
	);
}

function HookRow({
	hook,
	number,
	selected,
}: {
	hook: LoadedHook;
	number: number;
	selected: boolean;
}): React.ReactElement {
	const commandLabel = `[command] ${hook.hook.command}`;
	return (
		<SelectRow selected={selected}>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{`${number}.`.padStart(3)}{" "}
			</Text>
			<Text color={selected ? theme.accentBright : theme.text} bold={selected}>
				{commandLabel}
			</Text>
			<Text color={selected ? theme.accentBright : theme.subtle}>
				{"  "}
				{matcherSourceLabel(hook)}
			</Text>
		</SelectRow>
	);
}

function HookHelp({ event }: { event: HookEventName }): React.ReactElement {
	return (
		<Box flexDirection="column" marginBottom={1}>
			{hookHelpLines(event).map((line) => (
				<Text key={line} color={theme.subtle}>
					{line}
				</Text>
			))}
		</Box>
	);
}

function matcherSourceLabel(hook: LoadedHook): string {
	return hook.source.kind === "user" ? "(personal)" : "(project)";
}

function hookKey(hook: LoadedHook): string {
	return [
		hook.source.kind,
		hook.source.path,
		hook.event,
		hook.matcher ?? "*",
		hook.hash,
		hook.hook.command,
	].join(":");
}
