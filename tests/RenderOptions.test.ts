import { describe, expect, it } from "bun:test";
import {
	interactiveRenderOptions,
	resolveInteractiveRenderConfig,
} from "../src/ui/renderOptions.ts";

describe("interactive render options", () => {
	it("uses a balanced default frame ceiling", () => {
		expect(resolveInteractiveRenderConfig(undefined)).toEqual({
			maxFps: 30,
		});
	});

	it("preserves each root's Ctrl+C behavior", () => {
		expect(
			interactiveRenderOptions({ exitOnCtrlC: false, maxFps: 30 }),
		).toEqual({
			exitOnCtrlC: false,
			maxFps: 30,
		});
		expect(interactiveRenderOptions({ exitOnCtrlC: true, maxFps: 30 })).toEqual(
			{
				exitOnCtrlC: true,
				maxFps: 30,
			},
		);
	});

	it("accepts bounded integer frame-rate overrides", () => {
		for (const [value, expected] of [
			["1", 1],
			[" 30 ", 30],
			["120", 120],
		] as const) {
			expect(resolveInteractiveRenderConfig(value)).toEqual({
				maxFps: expected,
			});
		}
	});

	it("clamps numeric overrides and explains the adjustment", () => {
		expect(resolveInteractiveRenderConfig("0")).toEqual({
			maxFps: 1,
			warning: 'BACKBOARD_MAX_FPS "0" is outside 1-120; using 1.',
		});
		expect(resolveInteractiveRenderConfig("121")).toEqual({
			maxFps: 120,
			warning: 'BACKBOARD_MAX_FPS "121" is outside 1-120; using 120.',
		});
	});

	it("falls back with a warning for malformed overrides", () => {
		expect(resolveInteractiveRenderConfig("30fps")).toEqual({
			maxFps: 30,
			warning:
				'Invalid BACKBOARD_MAX_FPS "30fps"; using 30. Expected an integer from 1 to 120.',
		});
	});

	it("reads the production environment when no value is passed", () => {
		const previous = process.env.BACKBOARD_MAX_FPS;
		process.env.BACKBOARD_MAX_FPS = "45";
		try {
			expect(resolveInteractiveRenderConfig()).toEqual({ maxFps: 45 });
		} finally {
			if (previous === undefined) delete process.env.BACKBOARD_MAX_FPS;
			else process.env.BACKBOARD_MAX_FPS = previous;
		}
	});
});
