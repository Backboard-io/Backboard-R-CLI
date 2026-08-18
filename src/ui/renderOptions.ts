export const INTERACTIVE_RENDER_MAX_FPS = 60;

export function interactiveRenderOptions(exitOnCtrlC: boolean): {
	exitOnCtrlC: boolean;
	maxFps: number;
} {
	return {
		exitOnCtrlC,
		maxFps: INTERACTIVE_RENDER_MAX_FPS,
	};
}
