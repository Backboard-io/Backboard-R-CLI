import { insertPromptInputText } from "./PromptInputEditing.ts";
import type { PromptInputEdit } from "./types.ts";

/** Prompt-side view of a pending attachment: label lives inside the text. */
export interface PromptInputAttachmentChip {
	id: string;
	label: string;
	fileName: string;
	filePath: string;
}

export type PromptInputAttachmentChips = readonly PromptInputAttachmentChip[];

export function insertAttachmentChipLabels(
	edit: PromptInputEdit,
	chips: PromptInputAttachmentChips,
): PromptInputEdit {
	if (chips.length === 0) return edit;
	const before = edit.value.slice(0, edit.cursorOffset);
	const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
	const text = `${needsLeadingSpace ? " " : ""}${chips
		.map((chip) => chip.label)
		.join(" ")} `;
	return insertPromptInputText(edit, text);
}

export function preserveAttachmentChips(
	value: string,
	chips: PromptInputAttachmentChips,
): PromptInputAttachmentChip[] {
	return chips.filter((chip) => value.includes(chip.label));
}

export function droppedAttachmentChipIds(
	before: PromptInputAttachmentChips,
	after: PromptInputAttachmentChips,
): string[] {
	const kept = new Set(after.map((chip) => chip.id));
	return before.filter((chip) => !kept.has(chip.id)).map((chip) => chip.id);
}

/** Submitted marker: flags the file as an upload, keeping its real path. */
export function attachmentSubmitMarker(
	chip: PromptInputAttachmentChip,
): string {
	return `[attached: ${chip.filePath || chip.fileName}]`;
}

/** Replaces chip labels with [attached: path] markers; ids ordered by occurrence. */
export function resolveAttachmentSubmit(
	value: string,
	chips: PromptInputAttachmentChips,
): { value: string; attachmentIds: string[] } {
	const present = chips
		.map((chip) => ({ chip, index: value.indexOf(chip.label) }))
		.filter((entry) => entry.index !== -1)
		.sort((a, b) => a.index - b.index);
	let resolved = value;
	for (const { chip } of present) {
		resolved = resolved.replace(chip.label, attachmentSubmitMarker(chip));
	}
	return {
		value: resolved.trim(),
		attachmentIds: present.map(({ chip }) => chip.id),
	};
}
