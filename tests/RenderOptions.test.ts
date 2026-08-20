import { describe, expect, it } from "bun:test";
import { resolveInteractiveRenderConfig } from "../src/ui/renderOptions.ts";

describe("interactive render options", () => {
	it("uses a balanced default frame ceiling", () => {
		expect(resolveInteractiveRenderConfig("")).toEqual({
			maxFps: 30,
			warnings: [],
		});
	});

	it("accepts bounded integer frame-rate overrides", () => {
		for (const [value, expected] of [
			["1", 1],
			[" 30 ", 30],
			["120", 120],
		] as const) {
			expect(resolveInteractiveRenderConfig(value)).toEqual({
				maxFps: expected,
				warnings: [],
			});
		}
	});

	it("clamps numeric overrides and explains the adjustment", () => {
		expect(resolveInteractiveRenderConfig("0")).toEqual({
			maxFps: 1,
			warnings: ['BACKBOARD_MAX_FPS "0" is outside 1-120; using 1.'],
		});
		expect(resolveInteractiveRenderConfig("121")).toEqual({
			maxFps: 120,
			warnings: ['BACKBOARD_MAX_FPS "121" is outside 1-120; using 120.'],
		});
	});

	it("falls back with a warning for malformed overrides", () => {
		expect(resolveInteractiveRenderConfig("30fps")).toEqual({
			maxFps: 30,
			warnings: [
				'Invalid BACKBOARD_MAX_FPS "30fps"; using 30. Expected an integer from 1 to 120.',
			],
		});
	});

	it("sanitizes and bounds malformed values before warning", () => {
		const result = resolveInteractiveRenderConfig(
			`\u001B]0;pwned\u0007${"x".repeat(200)}\nnext`,
		);

		expect(result.maxFps).toBe(30);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).not.toContain("\u001B");
		expect(result.warnings[0]).not.toContain("\u0007");
		expect(result.warnings[0]).not.toContain("\n");
		expect(result.warnings[0]?.length ?? 0).toBeLessThan(220);
	});

	it("reads the production environment when no value is passed", () => {
		const previous = process.env.BACKBOARD_MAX_FPS;
		process.env.BACKBOARD_MAX_FPS = "45";
		try {
			expect(resolveInteractiveRenderConfig()).toEqual({
				maxFps: 45,
				warnings: [],
			});
		} finally {
			if (previous === undefined) delete process.env.BACKBOARD_MAX_FPS;
			else process.env.BACKBOARD_MAX_FPS = previous;
		}
	});
});
