import { detectEol, fromLogicalLines, toLogicalLines } from "./eol.ts";

export type PatchOperation =
	| { kind: "add"; path: string; lines: string[] }
	| { kind: "delete"; path: string }
	| {
			kind: "update";
			path: string;
			movePath?: string;
			hunks: PatchHunk[];
	  };

export interface PatchHunk {
	context?: string;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
	addedLineCount: number;
	removedLineCount: number;
}

const PATCH_BEGIN = `*** Begin ${"Patch"}`;
const PATCH_END = `*** End ${"Patch"}`;
const ADD_FILE_PREFIX = `*** Add ${"File"}: `;
const DELETE_FILE_PREFIX = `*** Delete ${"File"}: `;
const UPDATE_FILE_PREFIX = `*** Update ${"File"}: `;
const MOVE_TO_PREFIX = "*** Move to: ";
const END_OF_FILE = `*** End of ${"File"}`;

export function parsePatch(patch: string): PatchOperation[] {
	const lines = trimTrailingEmptyLine(
		patch.replaceAll("\r\n", "\n").split("\n"),
	);
	if (lines[0] !== PATCH_BEGIN) {
		throw new Error("patch must start with *** Begin Patch");
	}
	if (lines.at(-1) !== PATCH_END) {
		throw new Error("patch must end with *** End Patch");
	}

	const operations: PatchOperation[] = [];
	let index = 1;
	while (index < lines.length - 1) {
		const line = lines[index];
		if (!line) {
			index++;
			continue;
		}
		if (line.startsWith(ADD_FILE_PREFIX)) {
			const path = line.slice(ADD_FILE_PREFIX.length).trim();
			if (!path) throw new Error("Add File path is required");
			const parsed = parseAddFile(lines, index + 1);
			operations.push({ kind: "add", path, lines: parsed.lines });
			index = parsed.nextIndex;
			continue;
		}
		if (line.startsWith(DELETE_FILE_PREFIX)) {
			const path = line.slice(DELETE_FILE_PREFIX.length).trim();
			if (!path) throw new Error("Delete File path is required");
			operations.push({ kind: "delete", path });
			index++;
			continue;
		}
		if (line.startsWith(UPDATE_FILE_PREFIX)) {
			const path = line.slice(UPDATE_FILE_PREFIX.length).trim();
			if (!path) throw new Error("Update File path is required");
			const parsed = parseUpdateFile(lines, index + 1);
			operations.push({
				kind: "update",
				path,
				movePath: parsed.movePath,
				hunks: parsed.hunks,
			});
			index = parsed.nextIndex;
			continue;
		}
		throw new Error(`unexpected patch line at line ${index + 1}: ${line}`);
	}

	if (operations.length === 0) throw new Error("patch has no operations");
	return operations;
}

export function applyPatchUpdate(
	original: string,
	hunks: readonly PatchHunk[],
	path = "file",
): string {
	const eol = detectEol(original);
	const state = toLogicalLines(original);
	let cursor = 0;

	for (const hunk of hunks) {
		if (hunk.context !== undefined) {
			const contextIndex = findSubarray(
				state.lines,
				[hunk.context],
				cursor,
				false,
			);
			if (contextIndex === -1) {
				throw new Error(`Failed to find context '${hunk.context}' in ${path}`);
			}
			cursor = contextIndex + 1;
		}

		let expected = hunk.oldLines;
		let replacement = hunk.newLines;
		let matchIndex =
			expected.length === 0
				? hunk.context === undefined
					? state.lines.length
					: cursor
				: findSubarray(state.lines, expected, cursor, hunk.isEndOfFile);
		if (
			matchIndex === -1 &&
			expected.at(-1) === "" &&
			replacement.at(-1) === ""
		) {
			expected = expected.slice(0, -1);
			replacement = replacement.slice(0, -1);
			matchIndex = findSubarray(
				state.lines,
				expected,
				cursor,
				hunk.isEndOfFile,
			);
		}
		if (matchIndex === -1) {
			throw new Error(`Failed to find expected lines in ${path}`);
		}
		state.lines.splice(matchIndex, expected.length, ...replacement);
		cursor = matchIndex + replacement.length;
		if (expected.length === 0) state.hasFinalNewline = true;
	}

	return fromLogicalLines(state.lines, eol, state.hasFinalNewline);
}

export function contentFromAddedLines(
	lines: readonly string[],
	eol: string,
): string {
	if (lines.length === 0) return "";
	return `${lines.join(eol)}${eol}`;
}

function parseAddFile(
	lines: string[],
	startIndex: number,
): { lines: string[]; nextIndex: number } {
	const added: string[] = [];
	let index = startIndex;
	while (index < lines.length - 1 && !isFileHeader(lines[index] ?? "")) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.startsWith("+")) {
			added.push(line.slice(1));
			index++;
			continue;
		}
		throw new Error(
			`Add File lines must start with + at line ${index + 1}: ${line}`,
		);
	}
	return { lines: added, nextIndex: index };
}

function parseUpdateFile(
	lines: string[],
	startIndex: number,
): { hunks: PatchHunk[]; movePath?: string; nextIndex: number } {
	const hunks: PatchHunk[] = [];
	let current = createHunk();
	let index = startIndex;
	let movePath: string | undefined;
	if (index < lines.length - 1 && lines[index]?.startsWith(MOVE_TO_PREFIX)) {
		movePath = lines[index]?.slice(MOVE_TO_PREFIX.length).trim();
		if (!movePath) throw new Error("Move to path is required");
		index++;
	}
	while (index < lines.length - 1 && !isFileHeader(lines[index] ?? "")) {
		const line = lines[index];
		if (line === undefined) break;
		if (line.startsWith("@@")) {
			if (hasHunkLines(current)) {
				hunks.push(current);
			}
			current = createHunk(line.slice(2).trim() || undefined);
			index++;
			continue;
		}
		if (line === END_OF_FILE) {
			current.isEndOfFile = true;
			index++;
			continue;
		}
		if (line.startsWith(" ")) {
			const text = line.slice(1);
			current.oldLines.push(text);
			current.newLines.push(text);
			index++;
			continue;
		}
		if (line.startsWith("+")) {
			current.newLines.push(line.slice(1));
			current.addedLineCount++;
			index++;
			continue;
		}
		if (line.startsWith("-")) {
			current.oldLines.push(line.slice(1));
			current.removedLineCount++;
			index++;
			continue;
		}
		if (line.startsWith("\\")) {
			index++;
			continue;
		}
		throw new Error(
			`Update File lines must start with @@, space, +, or - at line ${index + 1}: ${line}`,
		);
	}
	if (hasHunkLines(current)) hunks.push(current);
	if (hunks.length === 0 && movePath === undefined) {
		throw new Error("Update File has no changes");
	}
	return { hunks, movePath, nextIndex: index };
}

function findSubarray(
	lines: readonly string[],
	expected: readonly string[],
	start: number,
	isEndOfFile: boolean,
): number {
	if (expected.length === 0) return start;
	if (expected.length > lines.length) return -1;
	const endStart = lines.length - expected.length;
	if (isEndOfFile && matchesAt(lines, expected, endStart)) return endStart;
	for (let index = start; index <= lines.length - expected.length; index++) {
		if (matchesAt(lines, expected, index)) return index;
	}
	return -1;
}

function matchesAt(
	lines: readonly string[],
	expected: readonly string[],
	index: number,
): boolean {
	return (
		expected.every((line, offset) => lines[index + offset] === line) ||
		expected.every(
			(line, offset) => lines[index + offset]?.trimEnd() === line.trimEnd(),
		) ||
		expected.every(
			(line, offset) => lines[index + offset]?.trim() === line.trim(),
		) ||
		expected.every(
			(line, offset) =>
				normalizePatchLine(lines[index + offset] ?? "") ===
				normalizePatchLine(line),
		)
	);
}

function trimTrailingEmptyLine(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

function isFileHeader(line: string): boolean {
	return (
		line.startsWith(ADD_FILE_PREFIX) ||
		line.startsWith(DELETE_FILE_PREFIX) ||
		line.startsWith(UPDATE_FILE_PREFIX)
	);
}

function createHunk(context?: string): PatchHunk {
	return {
		context,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
		addedLineCount: 0,
		removedLineCount: 0,
	};
}

function hasHunkLines(hunk: PatchHunk): boolean {
	return hunk.oldLines.length > 0 || hunk.newLines.length > 0;
}

function normalizePatchLine(line: string): string {
	return line
		.trim()
		.replaceAll(/[\u2010-\u2015\u2212]/g, "-")
		.replaceAll(/[\u2018-\u201B]/g, "'")
		.replaceAll(/[\u201C-\u201F]/g, '"')
		.replaceAll(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
