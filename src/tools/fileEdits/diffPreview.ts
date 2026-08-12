import type { ToolResultDetailLine } from "../../core/tools/ToolResultDetail.ts";
import { expandTabs } from "../../utils/string.ts";

type DiffKind = "context" | "add" | "remove";

interface DiffOp {
	kind: DiffKind;
	oldLine?: number;
	newLine?: number;
	text: string;
}

interface DiffHunk {
	start: number;
	end: number;
	changedLines: number;
}

const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_LINES = 18;
const MAX_LCS_CELLS = 200_000;
const FINAL_NEWLINE_SENTINEL = "\0final-newline";
const FINAL_NEWLINE_DISPLAY = "\\ Final newline";

export function buildEditDiffDetailLines(
	filePath: string,
	original: string,
	updated: string,
	options: { contextLines?: number; maxLines?: number } = {},
): ToolResultDetailLine[] {
	const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const trackFinalNewline =
		endsWithLineBreak(original) !== endsWithLineBreak(updated);
	const oldLines = splitDisplayLines(original, trackFinalNewline);
	const newLines = splitDisplayLines(updated, trackFinalNewline);
	const ops = diffLineOps(oldLines, newLines);
	const hunks = diffHunks(ops, contextLines);
	const visible = visibleHunks(ops, hunks, maxLines);
	const oldWidth = Math.max(3, String(oldLines.length || 1).length);
	const newWidth = Math.max(3, String(newLines.length || 1).length);
	const lines: ToolResultDetailLine[] = [
		detailLine("header", formatHeader(oldWidth, newWidth), "neutral"),
	];

	for (const hunk of visible.hunks) {
		lines.push(
			detailLine(
				`hunk:${hunk.start}`,
				formatHunk(filePath, ops[hunk.start], oldWidth, newWidth),
				"neutral",
			),
		);
		for (let index = hunk.start; index <= hunk.end; index++) {
			const op = ops[index];
			if (!op) continue;
			lines.push(
				detailLine(
					`line:${index}`,
					formatOp(op, oldWidth, newWidth),
					op.kind === "add"
						? "added"
						: op.kind === "remove"
							? "removed"
							: "neutral",
				),
			);
		}
	}

	if (visible.hiddenHunks > 0) {
		lines.push(
			detailLine(
				"truncated",
				`... ${visible.hiddenHunks} more hunk(s), ${visible.hiddenChangedLines} changed line(s) hidden`,
				"neutral",
			),
		);
	} else if (visible.hiddenChangedLines > 0) {
		lines.push(
			detailLine(
				"truncated",
				`... ${visible.hiddenChangedLines} changed line(s) hidden`,
				"neutral",
			),
		);
	}

	return lines;
}

function detailLine(
	key: string,
	displayValue: string,
	kind: "added" | "removed" | "neutral",
): ToolResultDetailLine {
	return {
		key,
		displayValue,
		highlighted: kind !== "neutral",
		kind,
	};
}

function diffLineOps(
	oldLines: readonly string[],
	newLines: readonly string[],
): DiffOp[] {
	let prefix = 0;
	while (
		prefix < oldLines.length &&
		prefix < newLines.length &&
		oldLines[prefix] === newLines[prefix]
	) {
		prefix++;
	}

	let oldSuffix = oldLines.length - 1;
	let newSuffix = newLines.length - 1;
	while (
		oldSuffix >= prefix &&
		newSuffix >= prefix &&
		oldLines[oldSuffix] === newLines[newSuffix]
	) {
		oldSuffix--;
		newSuffix--;
	}

	const ops: DiffOp[] = [];
	for (let index = 0; index < prefix; index++) {
		ops.push({
			kind: "context",
			oldLine: index + 1,
			newLine: index + 1,
			text: oldLines[index] ?? "",
		});
	}

	const oldMiddle = oldLines.slice(prefix, oldSuffix + 1);
	const newMiddle = newLines.slice(prefix, newSuffix + 1);
	ops.push(...diffMiddle(oldMiddle, newMiddle, prefix));

	const suffixCount = oldLines.length - oldSuffix - 1;
	for (let offset = suffixCount - 1; offset >= 0; offset--) {
		const oldIndex = oldLines.length - offset - 1;
		const newIndex = newLines.length - offset - 1;
		ops.push({
			kind: "context",
			oldLine: oldIndex + 1,
			newLine: newIndex + 1,
			text: oldLines[oldIndex] ?? "",
		});
	}

	return ops;
}

function diffMiddle(
	oldLines: readonly string[],
	newLines: readonly string[],
	offset: number,
): DiffOp[] {
	if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
		return [
			...oldLines.map((text, index) => ({
				kind: "remove" as const,
				oldLine: offset + index + 1,
				text,
			})),
			...newLines.map((text, index) => ({
				kind: "add" as const,
				newLine: offset + index + 1,
				text,
			})),
		];
	}

	const width = newLines.length + 1;
	const dp = new Array<number>((oldLines.length + 1) * width).fill(0);
	const at = (oldIndex: number, newIndex: number): number =>
		oldIndex * width + newIndex;
	const score = (oldIndex: number, newIndex: number): number =>
		dp[at(oldIndex, newIndex)] ?? 0;

	for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex--) {
		for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex--) {
			dp[at(oldIndex, newIndex)] =
				oldLines[oldIndex] === newLines[newIndex]
					? score(oldIndex + 1, newIndex + 1) + 1
					: Math.max(
							score(oldIndex + 1, newIndex),
							score(oldIndex, newIndex + 1),
						);
		}
	}

	const ops: DiffOp[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (
			oldIndex < oldLines.length &&
			newIndex < newLines.length &&
			oldLines[oldIndex] === newLines[newIndex]
		) {
			ops.push({
				kind: "context",
				oldLine: offset + oldIndex + 1,
				newLine: offset + newIndex + 1,
				text: oldLines[oldIndex] ?? "",
			});
			oldIndex++;
			newIndex++;
			continue;
		}
		if (
			newIndex < newLines.length &&
			(oldIndex === oldLines.length ||
				score(oldIndex, newIndex + 1) > score(oldIndex + 1, newIndex))
		) {
			ops.push({
				kind: "add",
				newLine: offset + newIndex + 1,
				text: newLines[newIndex] ?? "",
			});
			newIndex++;
			continue;
		}
		ops.push({
			kind: "remove",
			oldLine: offset + oldIndex + 1,
			text: oldLines[oldIndex] ?? "",
		});
		oldIndex++;
	}

	return ops;
}

function diffHunks(ops: readonly DiffOp[], contextLines: number): DiffHunk[] {
	const rawHunks: DiffHunk[] = [];
	for (let index = 0; index < ops.length; index++) {
		if (ops[index]?.kind === "context") continue;
		const start = Math.max(0, index - contextLines);
		let end = index;
		let changedLines = 0;
		while (index < ops.length) {
			if (ops[index]?.kind !== "context") {
				changedLines++;
				end = Math.min(ops.length - 1, index + contextLines);
			} else if (index > end) {
				break;
			}
			index++;
		}
		rawHunks.push({ start, end, changedLines });
	}

	const merged: DiffHunk[] = [];
	for (const hunk of rawHunks) {
		const previous = merged.at(-1);
		if (previous && hunk.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, hunk.end);
			previous.changedLines += hunk.changedLines;
			continue;
		}
		merged.push({ ...hunk });
	}
	return merged;
}

function visibleHunks(
	ops: readonly DiffOp[],
	hunks: readonly DiffHunk[],
	maxLines: number,
): {
	hunks: DiffHunk[];
	hiddenHunks: number;
	hiddenChangedLines: number;
} {
	const visible: DiffHunk[] = [];
	let usedLines = 0;
	for (const hunk of hunks) {
		const lineCount = hunk.end - hunk.start + 2;
		if (visible.length > 0 && usedLines + lineCount > maxLines) break;
		if (visible.length === 0 && lineCount > maxLines) {
			const trimmed = trimHunk(ops, hunk, Math.max(1, maxLines - 1));
			visible.push(trimmed);
			const hidden = hunks.slice(1);
			return {
				hunks: visible,
				hiddenHunks: hidden.length,
				hiddenChangedLines:
					hunk.changedLines -
					trimmed.changedLines +
					hidden.reduce((total, item) => total + item.changedLines, 0),
			};
		}
		visible.push(hunk);
		usedLines += lineCount;
	}
	const hidden = hunks.slice(visible.length);
	return {
		hunks: visible,
		hiddenHunks: hidden.length,
		hiddenChangedLines: hidden.reduce(
			(total, hunk) => total + hunk.changedLines,
			0,
		),
	};
}

function trimHunk(
	ops: readonly DiffOp[],
	hunk: DiffHunk,
	maxOps: number,
): DiffHunk {
	let end = hunk.start;
	let changedLines = 0;
	for (
		let index = hunk.start;
		index <= hunk.end && index < hunk.start + maxOps;
		index++
	) {
		end = index;
		if (ops[index]?.kind !== "context") changedLines++;
	}
	return { start: hunk.start, end, changedLines };
}

function formatHeader(oldWidth: number, newWidth: number): string {
	return `${"old".padStart(oldWidth)} ${"new".padStart(newWidth)} │`;
}

function formatHunk(
	filePath: string,
	op: DiffOp | undefined,
	oldWidth: number,
	newWidth: number,
): string {
	const oldLine = op?.oldLine ?? "";
	const newLine = op?.newLine ?? "";
	return `${formatNumber(oldLine, oldWidth)} ${formatNumber(
		newLine,
		newWidth,
	)} │ @@ ${filePath}`;
}

function formatOp(op: DiffOp, oldWidth: number, newWidth: number): string {
	return `${formatNumber(op.oldLine ?? "", oldWidth)} ${formatNumber(
		op.newLine ?? "",
		newWidth,
	)} │ ${formatText(op.text)}`;
}

function formatNumber(value: number | "", width: number): string {
	return value === "" ? " ".repeat(width) : String(value).padStart(width);
}

function formatText(text: string): string {
	return text === FINAL_NEWLINE_SENTINEL
		? FINAL_NEWLINE_DISPLAY
		: expandTabs(text);
}

function splitDisplayLines(
	value: string,
	trackFinalNewline: boolean,
): string[] {
	const normalized = value.replaceAll("\r\n", "\n");
	if (normalized === "") return [];
	const lines = normalized.split("\n");
	if (endsWithLineBreak(normalized)) lines.pop();
	if (trackFinalNewline && endsWithLineBreak(normalized)) {
		lines.push(FINAL_NEWLINE_SENTINEL);
	}
	return lines;
}

function endsWithLineBreak(value: string): boolean {
	return value.endsWith("\n");
}
