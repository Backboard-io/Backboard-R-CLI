import { Text, useInput } from "ink";
import type React from "react";
import type { MemoryMode } from "../../config/defaults.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { SelectRow } from "./SelectRow.tsx";

export interface SettingsState {
	memory: MemoryMode;
	expert: ExpertSettingsState;
	verbose: boolean;
	notify: boolean;
	lsp: boolean;
	lspPending: boolean;
	browser: boolean;
	computerUse: boolean;
	discover: boolean;
}

export interface ExpertSettingsState {
	enabled: boolean;
	/** The remembered pick, shown even while off so the choice stays visible. */
	model: string | null;
}

export type SettingsOpenId = "memory" | "expert";

export type SettingsToggleId =
	| "verbose"
	| "notify"
	| "lsp"
	| "browser"
	| "computerUse"
	| "discover";

export type SettingsRow =
	| {
			id: SettingsOpenId;
			kind: "open";
			label: string;
			value: string;
			description: string;
	  }
	| {
			id: SettingsToggleId;
			kind: "toggle";
			label: string;
			enabled: boolean;
			pending?: boolean;
			description: string;
	  };

const MEMORY_LABELS: Record<MemoryMode, string> = {
	off: "Off",
	on: "On",
	auto: "Auto",
	readonly: "Readonly",
};

export function settingsRows(state: SettingsState): SettingsRow[] {
	return [
		{
			id: "memory",
			kind: "open",
			label: "Memory",
			value: MEMORY_LABELS[state.memory],
			description: "Persistent memory mode",
		},
		{
			id: "expert",
			kind: "open",
			label: "Expert",
			value: expertValue(state.expert),
			description: "Plan here, implement on a second model",
		},
		{
			id: "verbose",
			kind: "toggle",
			label: "Verbose",
			enabled: state.verbose,
			description: "Detailed tool-call output",
		},
		{
			id: "notify",
			kind: "toggle",
			label: "Notify",
			enabled: state.notify,
			description: "Sound when a turn finishes",
		},
		{
			id: "lsp",
			kind: "toggle",
			label: "LSP",
			enabled: state.lsp,
			pending: state.lspPending,
			description: "Language-server diagnostics",
		},
		{
			id: "browser",
			kind: "toggle",
			label: "Browser",
			enabled: state.browser,
			description: "Browser automation tool",
		},
		{
			id: "computerUse",
			kind: "toggle",
			label: "Computer use",
			enabled: state.computerUse,
			description: "Local computer control",
		},
		{
			id: "discover",
			kind: "toggle",
			label: "Discovery",
			enabled: state.discover,
			description: "Skill & MCP discovery tools",
		},
	];
}

function expertValue(expert: ExpertSettingsState): string {
	if (!expert.enabled || !expert.model) return "Off";
	return expert.model;
}

function valueText(row: SettingsRow): string {
	if (row.kind === "toggle") {
		if (row.pending) return "○ …";
		return row.enabled ? "● On" : "○ Off";
	}
	return `${row.value} ›`;
}

interface Props {
	state: SettingsState;
	onToggle: (id: SettingsToggleId) => void;
	onOpen: (id: SettingsOpenId) => void;
	onClose: () => void;
}

export function SettingsPanel({
	state,
	onToggle,
	onOpen,
	onClose,
}: Props): React.ReactElement {
	const rows = settingsRows(state);
	const selection = useListSelection(rows.length);
	const labelWidth = Math.max(...rows.map((row) => row.label.length)) + 2;
	const valueWidth = Math.max(...rows.map((row) => valueText(row).length)) + 2;

	useInput((input, key) => {
		if (key.escape) {
			onClose();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (key.return) {
			const row = rows[selection.index];
			if (!row) return;
			if (row.kind === "toggle") {
				if (row.pending) return;
				onToggle(row.id);
			} else {
				onOpen(row.id);
			}
		}
	});

	return (
		<Panel title="Settings">
			{rows.map((row, position) => (
				<SettingsRowView
					key={row.id}
					row={row}
					selected={position === selection.index}
					labelWidth={labelWidth}
					valueWidth={valueWidth}
				/>
			))}
			<HintFooter hints={["↑/↓ move", "Enter toggle/open", "Esc close"]} />
		</Panel>
	);
}

function SettingsRowView({
	row,
	selected,
	labelWidth,
	valueWidth,
}: {
	row: SettingsRow;
	selected: boolean;
	labelWidth: number;
	valueWidth: number;
}): React.ReactElement {
	const nameColor = selected ? theme.accentBright : theme.subtle;
	const on =
		row.kind === "toggle"
			? row.enabled && !row.pending
			: row.id === "expert" && row.value !== "Off";
	const valueColor = on
		? theme.success
		: selected && row.kind === "open"
			? theme.text
			: theme.subtle;
	return (
		<SelectRow selected={selected}>
			<Text color={nameColor} bold={selected}>
				{row.label.padEnd(labelWidth)}
			</Text>
			<Text color={valueColor} bold={on}>
				{valueText(row).padEnd(valueWidth)}
			</Text>
			<Text color={theme.subtle}>{row.description}</Text>
		</SelectRow>
	);
}
