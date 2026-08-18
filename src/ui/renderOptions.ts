import type { RenderOptions } from "ink";

const DEFAULT_INTERACTIVE_RENDER_MAX_FPS = 60;
const MAX_INTERACTIVE_RENDER_MAX_FPS = 120;

interface InteractiveRenderOptionsInput {
	exitOnCtrlC: boolean;
	env?: Partial<Pick<NodeJS.ProcessEnv, "BACKBOARD_MAX_FPS">>;
}

type InteractiveRenderOptions = Pick<
	RenderOptions,
	"exitOnCtrlC" | "incrementalRendering" | "maxFps"
>;

export function interactiveRenderOptions({
	exitOnCtrlC,
	env,
}: InteractiveRenderOptionsInput): InteractiveRenderOptions {
	const maxFpsOverride =
		env === undefined ? process.env.BACKBOARD_MAX_FPS : env.BACKBOARD_MAX_FPS;
	return {
		exitOnCtrlC,
		incrementalRendering: true,
		maxFps: resolveInteractiveRenderMaxFps(maxFpsOverride),
	};
}

function resolveInteractiveRenderMaxFps(value: string | undefined): number {
	const normalized = value?.trim();
	if (!normalized || !/^\d+$/.test(normalized)) {
		return DEFAULT_INTERACTIVE_RENDER_MAX_FPS;
	}
	const parsed = Number(normalized);
	if (parsed < 1 || parsed > MAX_INTERACTIVE_RENDER_MAX_FPS) {
		return DEFAULT_INTERACTIVE_RENDER_MAX_FPS;
	}
	return parsed;
}
