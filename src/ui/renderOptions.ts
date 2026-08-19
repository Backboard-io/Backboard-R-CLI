import type { RenderOptions } from "ink";

const DEFAULT_INTERACTIVE_RENDER_MAX_FPS = 30;
const MIN_INTERACTIVE_RENDER_MAX_FPS = 1;
const MAX_INTERACTIVE_RENDER_MAX_FPS = 120;

interface InteractiveRenderOptionsInput {
	exitOnCtrlC: boolean;
	maxFps: number;
}

type InteractiveRenderOptions = Pick<RenderOptions, "exitOnCtrlC" | "maxFps">;

export function interactiveRenderOptions({
	exitOnCtrlC,
	maxFps,
}: InteractiveRenderOptionsInput): InteractiveRenderOptions {
	return {
		exitOnCtrlC,
		maxFps,
	};
}

export interface InteractiveRenderConfig {
	maxFps: number;
	warning?: string;
}

export function resolveInteractiveRenderConfig(
	value = process.env.BACKBOARD_MAX_FPS,
): InteractiveRenderConfig {
	const normalized = value?.trim();
	if (!normalized) {
		return { maxFps: DEFAULT_INTERACTIVE_RENDER_MAX_FPS };
	}
	if (!/^-?\d+$/.test(normalized)) {
		return {
			maxFps: DEFAULT_INTERACTIVE_RENDER_MAX_FPS,
			warning: `Invalid BACKBOARD_MAX_FPS "${value}"; using ${DEFAULT_INTERACTIVE_RENDER_MAX_FPS}. Expected an integer from ${MIN_INTERACTIVE_RENDER_MAX_FPS} to ${MAX_INTERACTIVE_RENDER_MAX_FPS}.`,
		};
	}

	const parsed = Number(normalized);
	const maxFps = Math.min(
		MAX_INTERACTIVE_RENDER_MAX_FPS,
		Math.max(MIN_INTERACTIVE_RENDER_MAX_FPS, parsed),
	);
	if (maxFps !== parsed) {
		return {
			maxFps,
			warning: `BACKBOARD_MAX_FPS "${value}" is outside ${MIN_INTERACTIVE_RENDER_MAX_FPS}-${MAX_INTERACTIVE_RENDER_MAX_FPS}; using ${maxFps}.`,
		};
	}
	return { maxFps };
}
