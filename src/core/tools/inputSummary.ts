import { truncate } from "../../utils/string.ts";
import { sanitizeForTerminal } from "../../utils/terminalSafe.ts";

/**
 * Helpers for the one-line parameter summary shown beneath a tool's name in the
 * transcript. Each tool owns its own summary via `Tool.summarizeInput()` using
 * these building blocks; `ToolEventFactory` clamps the result and supplies a
 * tool-agnostic fallback for tools that do not override.
 */

export const MAX_SUMMARY_LENGTH = 140;

// Collapse interior whitespace (so a multi-line prompt/command can't render
// across several rows) and clamp to a single readable line.
export function clampSummary(value: string): string {
	return truncate(
		sanitizeForTerminal(value).replace(/\s+/g, " ").trim(),
		MAX_SUMMARY_LENGTH,
	);
}

export function relativizePath(value: string): string {
	const cwd = process.cwd();
	if (value === cwd) return ".";
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** First line of a multi-line value, marked with an ellipsis when truncated. */
export function firstLine(value: string): string {
	const newlineIndex = value.indexOf("\n");
	if (newlineIndex === -1) return value;
	return `${value.slice(0, newlineIndex)} …`;
}

/** A Read-style ` (lines a–b)` / ` (from line a)` suffix from offset+limit. */
export function lineRange(offset?: number, limit?: number): string {
	if (offset === undefined && limit === undefined) return "";
	const start = (offset ?? 0) + 1;
	if (limit === undefined) return ` (from line ${start})`;
	return ` (lines ${start}–${start + limit - 1})`;
}

// Secondary parameters are collected into a single trailing "(...)" group so the
// primary identity (the command, pattern, or path) reads first and the filters
// stay visually secondary. The whole line renders uniformly subtle today
// (ToolCallView's InputSummary); the parenthesized grouping is the only
// separation, so keep any secondary info inside one "(...)" group.
export function withMeta(primary: string, meta: string[]): string {
	return meta.length ? `${primary} (${meta.join(", ")})` : primary;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter(
		(item): item is string => typeof item === "string" && item.length > 0,
	);
	return items.length ? items : undefined;
}

/**
 * Tool-agnostic fallback for tools that don't override `summarizeInput`: show a
 * conventional identity field (a file path, or a free-form url/query/prompt).
 * These field names are shared across many tools (Write/Edit/ApplyPatch all take
 * `file_path`), so they stay generic here — only tool-SPECIFIC parameter shapes
 * (commands, glob arrays, grep filters, Read's line range) live in each tool's
 * override.
 */
export function genericInputSummary(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const obj = input as Record<string, unknown>;
	const filePath = asString(obj.file_path) ?? asString(obj.path);
	if (filePath) return relativizePath(filePath);
	const other =
		asString(obj.url) ??
		asString(obj.query) ??
		asString(obj.question) ??
		asString(obj.prompt);
	return other ?? "";
}
