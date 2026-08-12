/**
 * Pure GFM-table primitives shared by the markdown renderer (parsing +
 * layout) and the assistant stream reducer (flush-boundary safety). Kept
 * dependency-free so both `ui/` and `state/` can import it without creating
 * a cross-layer dependency between them.
 */

export type TableAlign = "left" | "center" | "right";

const SEPARATOR_CELL_PATTERN = /^:?-+:?$/;
const PARTIAL_SEPARATOR_CELL_PATTERN = /^:?-*:?$/;

/**
 * Splits a `|`-delimited table row into trimmed cell strings, honoring
 * `\|` escapes and dropping the empty cell produced by optional outer
 * pipes (`| a | b |` vs `a | b`). Returns [] if the line isn't a pipe row.
 */
export function splitTableRow(line: string): string[] {
	const trimmed = line.trim();
	if (!trimmed.includes("|")) return [];

	const cells: string[] = [];
	let current = "";
	for (let i = 0; i < trimmed.length; i++) {
		const char = trimmed[i];
		if (char === "\\" && trimmed[i + 1] === "|") {
			current += "|";
			i += 1;
			continue;
		}
		if (char === "|") {
			cells.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current);

	if (cells.length > 1 && (cells[0] ?? "").trim() === "") cells.shift();
	if (cells.length > 1 && (cells.at(-1) ?? "").trim() === "") cells.pop();

	return cells.map((cell) => cell.trim());
}

/** True if every cell in the row is a GFM delimiter cell like `---` or `:--:`. */
export function isTableSeparatorRow(line: string): boolean {
	const cells = splitTableRow(line);
	if (cells.length === 0) return false;
	return cells.every((cell) => SEPARATOR_CELL_PATTERN.test(cell));
}

export function parseTableAlignment(separatorCells: string[]): TableAlign[] {
	return separatorCells.map((cell) => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		if (left && right) return "center";
		if (right) return "right";
		return "left";
	});
}

/**
 * True if `line`, together with the line that follows it, opens a GFM
 * table (a pipe row immediately followed by a matching delimiter row).
 */
export function isTableStart(line: string, nextLine: string): boolean {
	const header = splitTableRow(line);
	if (header.length === 0) return false;
	return (
		isTableSeparatorRow(nextLine) &&
		splitTableRow(nextLine).length === header.length
	);
}

/**
 * Scans `text` for a table that reaches all the way to the end without a
 * blank line or non-row line closing it off — i.e. a table that's still
 * being streamed in and may gain more rows. Returns the character offset
 * where that open table's header begins, or null if the text doesn't end
 * inside an open table.
 */
export function findOpenTableStart(text: string): number | null {
	const lines: string[] = [];
	const offsets: number[] = [];
	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i === text.length || text[i] === "\n") {
			lines.push(text.slice(lineStart, i));
			offsets.push(lineStart);
			lineStart = i + 1;
		}
	}
	// A trailing "\n" produces a synthetic empty final line representing
	// "nothing yet" rather than a real blank-line terminator — drop it.
	if (text.endsWith("\n")) {
		lines.pop();
		offsets.pop();
	}

	let openStart: number | null = null;
	let index = 0;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		const nextLine = lines[index + 1] ?? "";
		if (!isTableStart(line, nextLine)) {
			openStart = null;
			index += 1;
			continue;
		}

		const tableStart = offsets[index] ?? 0;
		let row = index + 2;
		while (row < lines.length && splitTableRow(lines[row] ?? "").length > 0) {
			row += 1;
		}
		// The row scan stopped because we ran out of lines (still open) vs.
		// because a blank/non-row line closed the table off.
		openStart = row >= lines.length ? tableStart : null;
		index = row;
	}

	if (openStart === null) {
		openStart = findPotentialTableStart(lines, offsets);
	}

	return openStart;
}

/**
 * A table isn't recognizable until both its header and delimiter rows have
 * streamed in, but by then the header may already have been flushed on its
 * own. This catches the earlier moment: the text ends in a pipe row that
 * could still turn out to be a table header (optionally followed by a
 * partial delimiter row). Returns the offset of that potential header, or
 * null. Self-correcting: once a following line rules the table out, the
 * held-back lines flush normally.
 */
function findPotentialTableStart(
	lines: readonly string[],
	offsets: readonly number[],
): number | null {
	let runStart = lines.length;
	while (runStart > 0 && splitTableRow(lines[runStart - 1] ?? "").length > 0) {
		runStart -= 1;
	}
	const runLength = lines.length - runStart;
	if (runLength === 1) return offsets[runStart] ?? null;
	if (runLength !== 2) return null;

	const headerCells = splitTableRow(lines[runStart] ?? "");
	const partialCells = splitTableRow(lines[runStart + 1] ?? "");
	const couldBeSeparator =
		partialCells.length <= headerCells.length &&
		partialCells.every((cell) => PARTIAL_SEPARATOR_CELL_PATTERN.test(cell));
	return couldBeSeparator ? (offsets[runStart] ?? null) : null;
}

/**
 * Adjusts a proposed flush length so it never slices an in-progress table
 * apart into separate, independently-rendered chunks. `maxUnboundedChars`
 * is a safety valve: if the open table has already grown past it, flush
 * anyway rather than buffering indefinitely.
 */
export function clampFlushLengthForOpenTable(
	text: string,
	flushLength: number,
	maxUnboundedChars: number,
): number {
	if (flushLength <= 0) return flushLength;

	const openStart = findOpenTableStart(text.slice(0, flushLength));
	if (openStart === null) return flushLength;
	if (openStart > 0) return openStart;

	return text.length > maxUnboundedChars ? flushLength : 0;
}
