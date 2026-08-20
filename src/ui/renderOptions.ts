import { truncate } from "../utils/string.ts";
import { sanitizeForTerminal } from "../utils/terminalSafe.ts";

const DEFAULT_INTERACTIVE_RENDER_MAX_FPS = 30;
const MIN_INTERACTIVE_RENDER_MAX_FPS = 1;
const MAX_INTERACTIVE_RENDER_MAX_FPS = 120;
const MAX_RENDER_ENV_VALUE_LENGTH = 120;

export interface InteractiveRenderConfig {
	maxFps: number;
	warnings: string[];
}

export function resolveInteractiveRenderConfig(
	value = process.env.BACKBOARD_MAX_FPS,
): InteractiveRenderConfig {
	const normalized = value?.trim();
	if (!normalized) {
		return { maxFps: DEFAULT_INTERACTIVE_RENDER_MAX_FPS, warnings: [] };
	}
	if (!/^-?\d+$/.test(normalized)) {
		const displayedValue = displayRenderEnvValue(value ?? "");
		return {
			maxFps: DEFAULT_INTERACTIVE_RENDER_MAX_FPS,
			warnings: [
				`Invalid BACKBOARD_MAX_FPS ${displayedValue}; using ${DEFAULT_INTERACTIVE_RENDER_MAX_FPS}. Expected an integer from ${MIN_INTERACTIVE_RENDER_MAX_FPS} to ${MAX_INTERACTIVE_RENDER_MAX_FPS}.`,
			],
		};
	}

	const parsed = Number(normalized);
	const maxFps = Math.min(
		MAX_INTERACTIVE_RENDER_MAX_FPS,
		Math.max(MIN_INTERACTIVE_RENDER_MAX_FPS, parsed),
	);
	if (maxFps !== parsed) {
		const displayedValue = displayRenderEnvValue(value ?? "");
		return {
			maxFps,
			warnings: [
				`BACKBOARD_MAX_FPS ${displayedValue} is outside ${MIN_INTERACTIVE_RENDER_MAX_FPS}-${MAX_INTERACTIVE_RENDER_MAX_FPS}; using ${maxFps}.`,
			],
		};
	}
	return { maxFps, warnings: [] };
}

function displayRenderEnvValue(value: string): string {
	const sanitized = sanitizeForTerminal(value).replace(/\s+/g, " ").trim();
	return JSON.stringify(truncate(sanitized, MAX_RENDER_ENV_VALUE_LENGTH));
}
