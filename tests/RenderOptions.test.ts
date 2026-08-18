import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { interactiveRenderOptions } from "../src/ui/renderOptions.ts";

describe("interactive render options", () => {
	it("uses incremental rendering with a responsive default ceiling", () => {
		expect(interactiveRenderOptions({ exitOnCtrlC: false, env: {} })).toEqual({
			exitOnCtrlC: false,
			incrementalRendering: true,
			maxFps: 60,
		});
	});

	it("preserves each root's Ctrl+C behavior", () => {
		expect(interactiveRenderOptions({ exitOnCtrlC: true, env: {} })).toEqual({
			exitOnCtrlC: true,
			incrementalRendering: true,
			maxFps: 60,
		});
	});

	it("accepts bounded integer frame-rate overrides", () => {
		for (const [value, expected] of [
			["1", 1],
			[" 30 ", 30],
			["120", 120],
		] as const) {
			expect(
				interactiveRenderOptions({
					exitOnCtrlC: false,
					env: { BACKBOARD_MAX_FPS: value },
				}).maxFps,
			).toBe(expected);
		}
	});

	it("falls back for invalid or excessive frame-rate overrides", () => {
		for (const value of ["0", "-1", "30.5", "fast", "121"]) {
			expect(
				interactiveRenderOptions({
					exitOnCtrlC: false,
					env: { BACKBOARD_MAX_FPS: value },
				}).maxFps,
			).toBe(60);
		}
	});

	it("keeps both CLI render roots on the shared configuration", () => {
		const cliSource = readFileSync(
			new URL("../src/entrypoints/cli.tsx", import.meta.url),
			"utf8",
		);

		expect(cliSource).toContain(
			"interactiveRenderOptions({ exitOnCtrlC: false })",
		);
		expect(cliSource).toContain(
			"interactiveRenderOptions({ exitOnCtrlC: true })",
		);
		expect(cliSource).not.toContain("maxFps: 12");
	});
});
