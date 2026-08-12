import { detectEol, normalizeTextToEol } from "./eol.ts";

export interface TextReplacement {
	old_str: string;
	new_str: string;
	replace_all?: boolean;
}

export interface TextReplacementResult {
	updated: string;
	replacements: number;
	addedLines: number;
	removedLines: number;
}

interface ReplacementRange {
	start: number;
	end: number;
	new_str: string;
	editIndex: number;
}

/**
 * Applies all edits against a single snapshot of the original content,
 * atomically: every old_str is resolved against `original` (never against the
 * result of an earlier edit), overlapping edits are rejected, and the caller
 * receives either the fully-updated text or an error naming the edit that
 * failed. This lets models write every old_str against the file as they read
 * it, without predicting intermediate states.
 */
export function applyTextReplacements(
	original: string,
	edits: readonly TextReplacement[],
): TextReplacementResult {
	const ranges: ReplacementRange[] = [];
	let addedLines = 0;
	let removedLines = 0;

	for (const [index, edit] of edits.entries()) {
		const normalized = normalizeEditForContent(original, edit);
		const starts = findOccurrences(original, normalized.old_str);
		if (starts.length === 0) {
			throw new Error(
				editError(index, edits.length, "old_str not found in file"),
			);
		}
		if (starts.length > 1 && !normalized.replace_all) {
			throw new Error(
				editError(
					index,
					edits.length,
					`old_str is not unique (${starts.length} matches). Set replace_all or add more context.`,
				),
			);
		}

		const matched = normalized.replace_all ? starts : starts.slice(0, 1);
		for (const start of matched) {
			ranges.push({
				start,
				end: start + normalized.old_str.length,
				new_str: normalized.new_str,
				editIndex: index,
			});
		}
		const delta = replacementLineDelta(
			normalized.old_str,
			normalized.new_str,
			matched.length,
		);
		addedLines += delta.added;
		removedLines += delta.removed;
	}

	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	for (let i = 1; i < ranges.length; i++) {
		const prev = ranges[i - 1];
		const current = ranges[i];
		if (prev && current && current.start < prev.end) {
			throw new Error(
				`edits ${prev.editIndex + 1} and ${current.editIndex + 1} overlap the same text; split them into separate calls`,
			);
		}
	}

	let updated = "";
	let cursor = 0;
	for (const range of ranges) {
		updated += original.slice(cursor, range.start) + range.new_str;
		cursor = range.end;
	}
	updated += original.slice(cursor);

	return { updated, replacements: ranges.length, addedLines, removedLines };
}

export function countOccurrences(haystack: string, needle: string): number {
	return findOccurrences(haystack, needle).length;
}

export function lineSummary(added: number, removed: number): string {
	return `Changed +${added}, -${removed} lines`;
}

function findOccurrences(haystack: string, needle: string): number[] {
	if (!needle) return [];
	const starts: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		starts.push(index);
		index = haystack.indexOf(needle, index + needle.length);
	}
	return starts;
}

function editError(index: number, total: number, message: string): string {
	return total > 1 ? `edit ${index + 1} of ${total}: ${message}` : message;
}

function normalizeEditForContent(
	content: string,
	edit: TextReplacement,
): TextReplacement {
	const eol = detectEol(content);
	if (
		eol === "\n" ||
		!edit.old_str.includes("\n") ||
		countOccurrences(content, edit.old_str) > 0
	) {
		return edit;
	}
	return {
		...edit,
		old_str: normalizeTextToEol(edit.old_str, eol),
		new_str: normalizeTextToEol(edit.new_str, eol),
	};
}

function replacementLineDelta(
	oldStr: string,
	newStr: string,
	replacements: number,
): { added: number; removed: number } {
	const removed = splitDisplayLines(oldStr).length * replacements;
	const added = splitDisplayLines(newStr).length * replacements;
	return { added, removed };
}

function splitDisplayLines(value: string): string[] {
	const lines = value.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines;
}
