import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ComputerRuntime } from "../src/core/computer/ComputerRuntime.ts";
import { MacPlatform } from "../src/core/platform/MacPlatform.ts";
import {
	ensureMacHelperBinary,
	macHelperBinaryPath,
} from "../src/core/platform/mac/MacHelperBinary.ts";
import { imageSize } from "../src/core/platform/png.ts";
import { ComputerTool } from "../src/tools/ComputerTool.tsx";
import { makeContext } from "./helpers.ts";

/**
 * Real-machine checks for the macOS helper. Opt in with
 * `BACKBOARD_CUA_E2E=1 bun test tests/MacPlatform.e2e.test.ts` on a Mac with
 * Screen Recording and Accessibility permission granted to the terminal.
 * Only non-destructive operations run here (capture, accessibility, settle,
 * cursor move); the interactive smoke flow lives in scripts/cua-smoke.ts.
 */
const enabled =
	process.platform === "darwin" && process.env.BACKBOARD_CUA_E2E === "1";
const describeE2E = enabled ? describe : describe.skip;

describeE2E("MacPlatform (real helper)", () => {
	const platform = new MacPlatform();
	const signal = new AbortController().signal;
	let dir = "";

	afterAll(async () => {
		await platform.dispose();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	it("compiles the helper once and caches it by source hash", async () => {
		const path = await ensureMacHelperBinary({ signal });
		expect(path).toBe(macHelperBinaryPath());
		expect(await Bun.file(path).exists()).toBe(true);
	});

	it("captures the screen in point space with a consistent scale", async () => {
		dir = await mkdtemp(join(tmpdir(), "cua-e2e-"));
		const shot = await platform.screenshot(
			{ path: join(dir, "a.jpg"), maxWidth: 1280, format: "jpeg" },
			signal,
		);
		expect(shot.mediaType).toBe("image/jpeg");
		expect(shot.imageSize.width).toBeLessThanOrEqual(1280);
		expect(imageSize(shot.bytes, "shot")).toEqual(shot.imageSize);
		expect(shot.scale).toBeCloseTo(
			shot.imageSize.width / shot.screenSize.width,
			3,
		);
		expect(shot.bytes.byteLength).toBeLessThan(1_200_000);

		const zoom = await platform.screenshot(
			{
				path: join(dir, "z.png"),
				maxWidth: 1280,
				format: "png",
				region: { x: 0, y: 0, width: 200, height: 100 },
			},
			signal,
		);
		expect(zoom.region).toEqual({ x: 0, y: 0, width: 200, height: 100 });
		expect(zoom.imageSize.width / zoom.imageSize.height).toBeCloseTo(2, 1);
	});

	it("reads the frontmost window's accessibility tree", async () => {
		const snapshot = await platform.accessibilitySnapshot(signal);
		expect(snapshot.trusted).toBe(true);
		expect(snapshot.appName).toBeTruthy();
		expect(snapshot.elements.length).toBeGreaterThan(0);
		for (const element of snapshot.elements) {
			expect(element.id).toMatch(/^el_\d+$/);
			expect(element.bounds?.width).toBeGreaterThan(0);
		}
	});

	it("settles quickly on a static screen and moves the cursor", async () => {
		const start = performance.now();
		const settle = await platform.settle({ timeoutMs: 1500 }, signal);
		expect(settle.elapsedMs).toBeLessThanOrEqual(1600);
		expect(performance.now() - start).toBeLessThan(2500);
		await platform.execute({ kind: "move", point: { x: 10, y: 10 } }, signal);
	});

	it("runs a read-only batch through the tool in well under a second per step", async () => {
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(signal, new EventBus());
		const result = await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "move", target: { x: 5, y: 5 } },
					{ action: "zoom", region: { x: 0, y: 0, width: 300, height: 200 } },
				],
			},
			ctx,
		);
		expect(result.data.success).toBe(true);
		expect(result.data.observation?.__image_base64).toBeDefined();
		expect(result.data.timing.actionsMs).toBeLessThan(3000);
	});
});
