import { describe, expect, it } from "bun:test";
import {
	INTERACTIVE_RENDER_MAX_FPS,
	interactiveRenderOptions,
} from "../src/ui/renderOptions.ts";

describe("interactive render options", () => {
	it("uses a responsive frame ceiling for each interactive root", () => {
		expect(INTERACTIVE_RENDER_MAX_FPS).toBe(60);
		expect(interactiveRenderOptions(false)).toEqual({
			exitOnCtrlC: false,
			maxFps: 60,
		});
		expect(interactiveRenderOptions(true)).toEqual({
			exitOnCtrlC: true,
			maxFps: 60,
		});
	});
});
