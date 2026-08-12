import { pluralize, truncate } from "../../utils/string.ts";
import { sanitizeForTerminal } from "../../utils/terminalSafe.ts";

const DEFAULT_MAX_LINES = 12;
const DEFAULT_MAX_LINE_WIDTH = 200;

/**
 * Preview length for low-signal "browsing" tools (Glob, Grep): their output is a
 * long list of paths/matches, so keep the transcript detail short.
 */
export const BROWSING_PREVIEW_LINES = 6;

export interface OutputPreviewOptions {
	/** Maximum number of content lines to keep before collapsing the rest. */
	maxLines?: number;
	/** Hard cap on each line's length; the renderer still trims to terminal width. */
	maxLineWidth?: number;
}

/**
 * Turn arbitrary (possibly huge) tool output into a compact, multi-line preview
 * suitable for a {@link ToolResult} `detail`. Keeps the first `maxLines` lines,
 * caps each line's width, and appends a "… +N more lines" footer when content is
 * dropped. Returns `undefined` when there is nothing worth showing.
 */
export function buildOutputPreview(
	text: string | undefined | null,
	options: OutputPreviewOptions = {},
): string | undefined {
	if (!text) return undefined;
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxLineWidth = options.maxLineWidth ?? DEFAULT_MAX_LINE_WIDTH;
	const source = sanitizeForTerminal(text).replace(/\s+$/u, "");
	if (!source) return undefined;
	const lines = source.split("\n");
	if (lines.length === 0) return undefined;
	const shown = lines
		.slice(0, maxLines)
		.map((line) => truncate(line, maxLineWidth));
	const hidden = lines.length - shown.length;
	if (hidden > 0) {
		shown.push(`… +${hidden} more ${pluralize(hidden, "line")}`);
	}
	return shown.join("\n");
}
