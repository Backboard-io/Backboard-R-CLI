import {
	SPINNER_SHADOW_GAP_FRAMES,
	SPINNER_SHADOW_WIDTH,
} from "./Spinner.constants.ts";
import type {
	SpinnerShadowRange,
	SpinnerShadowTone,
	SpinnerTextSegment,
} from "./Spinner.types.ts";

export function formatElapsedDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const days = Math.floor(totalSeconds / 86_400);
	const hours = Math.floor((totalSeconds % 86_400) / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = totalSeconds % 60;
	if (days > 0) {
		return `${days}d ${padUnit(hours)}h ${padUnit(minutes)}m ${padUnit(seconds)}s`;
	}
	if (hours > 0) {
		return `${hours}h ${padUnit(minutes)}m ${padUnit(seconds)}s`;
	}
	return `${minutes}m ${padUnit(seconds)}s`;
}

export function formatSpinnerMeta(
	elapsedMs: number | null,
	showInterruptHint: boolean,
): string | null {
	const parts = [
		elapsedMs === null ? "" : formatElapsedDuration(elapsedMs),
		showInterruptHint ? "esc to interrupt" : "",
	].filter(Boolean);
	if (parts.length === 0) return null;
	return `(${parts.join(" · ")})`;
}

export function spinnerShadowRange(
	label: string,
	frame: number,
): SpinnerShadowRange | null {
	if (label.length === 0) return null;
	const cycleLength = label.length + SPINNER_SHADOW_GAP_FRAMES;
	const start = positiveModulo(frame, cycleLength);
	if (start >= label.length) return null;
	return {
		start,
		end: Math.min(start + SPINNER_SHADOW_WIDTH, label.length),
	};
}

export function spinnerTextSegments(
	text: string,
	positionOffset: number,
	shadowRange: SpinnerShadowRange | null,
): SpinnerTextSegment[] {
	const segments: SpinnerTextSegment[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const tone = spinnerShadowTone(positionOffset + index, shadowRange);
		const char = text[index] ?? "";
		const last = segments[segments.length - 1];
		if (last?.tone === tone) {
			last.text += char;
			continue;
		}
		segments.push({ start: positionOffset + index, text: char, tone });
	}
	return segments;
}

export function spinnerSegmentDisplayText(segment: SpinnerTextSegment): string {
	return segment.tone === "shadowCore"
		? " ".repeat(segment.text.length)
		: segment.text;
}

function spinnerShadowTone(
	position: number,
	range: SpinnerShadowRange | null,
): SpinnerShadowTone {
	if (!range) return "normal";
	const offset = position - range.start;
	if (offset < 0 || position >= range.end) return "normal";
	if (offset <= 1) return "shadowTrail";
	if (offset <= 3) return "shadowCore";
	if (offset <= 5) return "shadowLead";
	return "normal";
}

function positiveModulo(value: number, modulus: number): number {
	return ((value % modulus) + modulus) % modulus;
}

function padUnit(value: number): string {
	return String(value).padStart(2, "0");
}
