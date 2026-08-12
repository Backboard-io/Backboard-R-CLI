import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import { formatClockTime } from "../../utils/time.ts";
import {
	LARGE_PASTE_MIN_LENGTH,
	LARGE_PASTE_MIN_LINES,
	PASTE_PREVIEW_TEXT_LENGTH,
} from "./PromptInput.constants.ts";
import { normalizePromptInputText } from "./PromptInputText.ts";

export interface PromptInputPastePreview {
	id: string;
	label: string;
	value: string;
}

export type PromptInputPastePreviews = readonly PromptInputPastePreview[];

export interface PromptInputPastePreviewOptions {
	now?: Date;
	sourceLabel?: string;
}

export function createPromptInputPastePreview(
	text: string,
	options: PromptInputPastePreviewOptions = {},
): PromptInputPastePreview | null {
	const value = normalizePromptInputText(text);
	if (!value) return null;
	const lineCount = value.split("\n").length;
	if (
		lineCount < LARGE_PASTE_MIN_LINES &&
		value.length < LARGE_PASTE_MIN_LENGTH
	) {
		return null;
	}

	const preview = value
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, PASTE_PREVIEW_TEXT_LENGTH);
	const suffix = lineCount > 1 ? `${lineCount} lines` : `${value.length} chars`;
	const sourceLabel = options.sourceLabel ?? `${APP_DISPLAY_NAME} You`;
	const now = options.now ?? new Date();
	const pasteId = stablePastePreviewId(value);
	return {
		id: pasteId,
		value,
		label: `[${sourceLabel}, ${formatPromptInputPasteTime(now)}, ${preview}... ${suffix}]`,
	};
}

export function shouldShowPromptInputPastePreview(
	value: string,
	previews: PromptInputPastePreviews,
): boolean {
	return previews.some((preview) => value.includes(preview.label));
}

export function preservePromptInputPastePreview(
	value: string,
	previews: PromptInputPastePreviews,
): PromptInputPastePreview[] {
	return previews.filter((preview) => value.includes(preview.label));
}

export function resolvePromptInputPasteValue(
	value: string,
	previews: PromptInputPastePreviews,
): string {
	return preservePromptInputPastePreview(value, previews).reduce(
		(resolved, preview) => resolved.replace(preview.label, preview.value),
		value,
	);
}

export function resolvePromptInputSubmitValue(
	value: string,
	previews: PromptInputPastePreviews,
	selectedCommand: string | undefined,
): string {
	const activePreviews = preservePromptInputPastePreview(value, previews);
	const resolvedValue = resolvePromptInputPasteValue(value, activePreviews);
	const trimmed = resolvedValue.trim();
	if (activePreviews.length > 0) return trimmed;
	return selectedCommand ?? trimmed;
}

function formatPromptInputPasteTime(date: Date): string {
	return formatClockTime(date);
}

function stablePastePreviewId(value: string): string {
	let hash = 0x811c9dc5;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash.toString(16).padStart(8, "0").slice(0, 8);
}
