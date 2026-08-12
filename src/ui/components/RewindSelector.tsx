import { basename } from "node:path";
import type React from "react";
import type {
	CheckpointSummary,
	RestorePlan,
	RestorePlanEntry,
} from "../../core/checkpoints/journalTypes.ts";
import { pluralize } from "../../utils/string.ts";
import { formatClockTime } from "../../utils/time.ts";
import { Picker, type PickerItem, type PickerTab } from "./Picker.tsx";

const MAX_DESCRIPTION_FILES = 3;
const MAX_LABEL_LENGTH = 48;

interface RewindProps {
	checkpoints: CheckpointSummary[];
	onSelect: (checkpoint: CheckpointSummary) => void;
	onCancel: () => void;
}

/** Picker over turn checkpoints (newest first) for `/rewind`. */
export function RewindSelector({
	checkpoints,
	onSelect,
	onCancel,
}: RewindProps): React.ReactElement {
	return (
		<Picker
			title={`Rewind Files · ${formatCheckpointCount(checkpoints.length)}`}
			tabs={checkpointTabs(checkpoints)}
			onSelect={(checkpoint) => onSelect(checkpoint)}
			onCancel={onCancel}
			emptyLabel="No checkpoints in this session yet."
		/>
	);
}

export type RestoreChoice =
	| "restore-all"
	| "skip-diverged"
	| "choose-files"
	| "cancel";

interface RestoreOptionsProps {
	plan: RestorePlan;
	summary: CheckpointSummary | null;
	onChoice: (choice: RestoreChoice) => void;
	onCancel: () => void;
}

/**
 * Options screen shown after a checkpoint is chosen: restore everything,
 * keep hand-edited files, cherry-pick files, or bail.
 */
export function RestoreOptions({
	plan,
	summary,
	onChoice,
	onCancel,
}: RestoreOptionsProps): React.ReactElement {
	const revertible = plan.entries.filter(isRevertible);
	const diverged = revertible.filter((entry) => entry.diverged);
	const remaining = revertible.length - diverged.length;
	const items: PickerItem<RestoreChoice>[] = [
		{
			id: "restore-all",
			name: `Restore all ${formatFileCount(revertible.length)}`,
			description:
				diverged.length > 0
					? `Overwrites ${formatFileCount(diverged.length)} edited outside the agent`
					: fileList(revertible.map((entry) => entry.path)),
			value: "restore-all",
		},
	];
	if (diverged.length > 0) {
		items.push({
			id: "skip-diverged",
			name: `Keep ${formatFileCount(diverged.length)} hand-edited, restore the rest`,
			description:
				remaining > 0
					? `Restores ${formatFileCount(remaining)} · keeps ${fileList(diverged.map((entry) => entry.path))}`
					: undefined,
			disabledReason:
				remaining === 0 ? "Every file was hand-edited" : undefined,
			value: "skip-diverged",
		});
	}
	items.push(
		{
			id: "choose-files",
			name: "Select which files to restore…",
			description: fileList(revertible.map((entry) => entry.path)),
			value: "choose-files",
		},
		{
			id: "cancel",
			name: "Cancel",
			description: "Leave all files unchanged",
			value: "cancel",
		},
	);
	return (
		<Picker
			title={`Rewind to ${quoteLabel(summary?.label ?? "")}`}
			tabs={[{ id: "options", label: "Options", items }]}
			onSelect={(choice) => onChoice(choice)}
			onCancel={onCancel}
			emptyLabel="Nothing to restore."
			showSearch={false}
		/>
	);
}

/** Sentinel id for the confirm row in the file-selection step. */
const CONFIRM_ID = "::confirm::";

interface FileSelectProps {
	plan: RestorePlan;
	included: ReadonlySet<string>;
	/** Toggles one path; the parent re-renders with the new set. */
	onToggle: (path: string) => void;
	/** Restores the currently included paths. */
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * Checkbox-style step for cherry-picking which files a rewind restores.
 * Selecting a file toggles it; selecting the confirm row applies.
 */
export function FileSelect({
	plan,
	included,
	onToggle,
	onConfirm,
	onCancel,
}: FileSelectProps): React.ReactElement {
	const revertible = plan.entries.filter(isRevertible);
	const items: PickerItem<string>[] = [
		{
			id: CONFIRM_ID,
			name: `Restore ${formatFileCount(included.size)}`,
			description: "Enter to apply",
			disabledReason: included.size === 0 ? "No files selected" : undefined,
			value: CONFIRM_ID,
		},
		...revertible.map((entry) => ({
			id: entry.path,
			name: `${included.has(entry.path) ? "◉" : "○"} ${basename(entry.path)}`,
			badge:
				entry.action === "delete" ? "-" : entry.diverged ? "~ edited" : "+",
			description: entry.path,
			spacingBefore: entry === revertible[0],
			value: entry.path,
		})),
	];
	return (
		<Picker
			title="Select files to restore"
			tabs={[{ id: "files", label: "Files", items }]}
			onSelect={(value) => {
				if (value === CONFIRM_ID) onConfirm();
				else onToggle(value);
			}}
			onCancel={onCancel}
			emptyLabel="Nothing to restore."
			showSearch={false}
		/>
	);
}

function isRevertible(entry: RestorePlanEntry): boolean {
	return entry.action === "write" || entry.action === "delete";
}

function checkpointTabs(
	checkpoints: readonly CheckpointSummary[],
): PickerTab<CheckpointSummary>[] {
	return [
		{
			id: "checkpoints",
			label: "Checkpoints",
			items: checkpoints.map((checkpoint) => ({
				id: checkpoint.id,
				name: `${formatClockTime(checkpoint.ts)}  ${quoteLabel(checkpoint.label)}`,
				badge: changeBadge(checkpoint),
				description: checkpointDescription(checkpoint),
				value: checkpoint,
			})),
		},
	];
}

/** `+added ~modified -removed`, zero-count segments omitted. */
function changeBadge(checkpoint: CheckpointSummary): string {
	const parts: string[] = [];
	if (checkpoint.added.length > 0) parts.push(`+${checkpoint.added.length}`);
	if (checkpoint.modified.length > 0)
		parts.push(`~${checkpoint.modified.length}`);
	if (checkpoint.removed.length > 0)
		parts.push(`-${checkpoint.removed.length}`);
	return parts.join(" ") || `${checkpoint.files.length}`;
}

function checkpointDescription(checkpoint: CheckpointSummary): string {
	const names = checkpoint.files.map((file) => basename(file));
	const shown = names.slice(0, MAX_DESCRIPTION_FILES);
	const overflow = names.length - shown.length;
	const parts = [shown.join(", ")];
	if (overflow > 0) parts.push(`+${overflow} more`);
	if (checkpoint.skippedFiles.length > 0) {
		parts.push(
			`${formatFileCount(checkpoint.skippedFiles.length)} not revertible`,
		);
	}
	return parts.filter(Boolean).join(" · ");
}

function fileList(paths: readonly string[]): string {
	const names = paths.map((file) => basename(file));
	const shown = names.slice(0, MAX_DESCRIPTION_FILES);
	const overflow = names.length - shown.length;
	return overflow > 0
		? `${shown.join(", ")} +${overflow} more`
		: shown.join(", ");
}

function quoteLabel(label: string): string {
	const trimmed = label.trim() || "(no message)";
	const short =
		trimmed.length > MAX_LABEL_LENGTH
			? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…`
			: trimmed;
	return `"${short}"`;
}

function formatCheckpointCount(count: number): string {
	return `${count} ${pluralize(count, "checkpoint")}`;
}

function formatFileCount(count: number): string {
	return `${count} ${pluralize(count, "file")}`;
}
