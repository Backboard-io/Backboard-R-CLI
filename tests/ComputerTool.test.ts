import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	formatComputerKey,
	normalizeComputerKey,
} from "../src/core/computer/ComputerKeys.ts";
import { ComputerPaths } from "../src/core/computer/ComputerPaths.ts";
import { refreshElementBounds } from "../src/core/computer/ComputerPlatformAction.ts";
import { ComputerRuntime } from "../src/core/computer/ComputerRuntime.ts";
import type { ComputerQueueResult } from "../src/core/computer/ComputerTypes.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	Platform,
	PlatformAction,
	ScreenshotCapture,
	ScreenshotOptions,
	SettleOptions,
	SettleResult,
} from "../src/core/platform/index.ts";
import { imageSize } from "../src/core/platform/png.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";
import { BrowserTool } from "../src/tools/BrowserTool.tsx";
import { ComputerTool } from "../src/tools/ComputerTool.tsx";
import { ReadTool } from "../src/tools/ReadTool.tsx";
import { parseCommand } from "../src/ui/commands/index.ts";
import { makeContext } from "./helpers.ts";

const env = { apiKey: "test-key", apiUrl: "https://example.test/api" };
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

class FakePlatform implements Platform {
	readonly os = "darwin" as const;
	actions: PlatformAction[] = [];
	screenshots: ScreenshotOptions[] = [];
	settles: SettleOptions[] = [];
	accessibilityCalls = 0;
	elements: AccessibilityElement[] = [];
	/** Elements returned by accessibility-only refreshes (after state changes). */
	refreshedElements: AccessibilityElement[] | null = null;
	appName = "FakeApp";
	windowTitle = "Fake Window";
	screen = { width: 1440, height: 900 };
	failNext: Error | null = null;
	disposed = false;

	async screenshot(options: ScreenshotOptions): Promise<ScreenshotCapture> {
		this.screenshots.push(options);
		await writeFile(options.path, tinyPng());
		const scale = Math.min(1, options.maxWidth / this.screen.width);
		return {
			path: options.path,
			bytes: tinyPng(),
			mediaType: "image/png",
			imageSize: {
				width: Math.round(this.screen.width * scale),
				height: Math.round(this.screen.height * scale),
			},
			screenSize: this.screen,
			scale,
			...(options.region ? { region: options.region } : {}),
		};
	}

	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		this.accessibilityCalls++;
		return {
			appName: this.appName,
			processId: 123,
			windowTitle: this.windowTitle,
			focusedElementId: this.elements.find((e) => e.focused)?.id,
			elements:
				this.accessibilityCalls > 1 && this.refreshedElements
					? this.refreshedElements
					: this.elements,
			trusted: true,
		};
	}

	async settle(options: SettleOptions): Promise<SettleResult> {
		this.settles.push(options);
		return { settled: true, elapsedMs: 5 };
	}

	async execute(action: PlatformAction): Promise<void> {
		if (this.failNext) {
			const err = this.failNext;
			this.failNext = null;
			throw err;
		}
		this.actions.push(action);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

function runtimeWith(platform: FakePlatform): ComputerRuntime {
	return new ComputerRuntime({ platform, settleTimeoutMs: 10 });
}

async function tempRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cua-test-"));
	tempDirs.push(dir);
	return dir;
}

function makeTool(platform: FakePlatform): ComputerTool {
	return new ComputerTool(runtimeWith(platform));
}

function ctx() {
	return makeContext(new AbortController().signal, new EventBus());
}

describe("ComputerTool input", () => {
	it("accepts the canonical batch shape and rejects bad input", () => {
		const tool = new ComputerTool();
		expect(tool.parseInput({ actions: [{ action: "screenshot" }] })).toEqual({
			actions: [{ action: "screenshot" }],
		});
		expect(() => tool.parseInput({ action: "screenshot" })).toThrow();
		expect(() => tool.parseInput({ actions: [] })).toThrow();
		expect(() =>
			tool.parseInput({
				actions: [{ action: "click", target: { elementId: "" } }],
			}),
		).toThrow();
		expect(() =>
			tool.parseInput({ actions: [{ action: "click", target: {} }] }),
		).toThrow();
	});

	it("normalizes provider dialects onto canonical actions", () => {
		const tool = new ComputerTool();
		expect(
			tool.parseInput({
				actions: [
					"screenshot",
					{ type: "left_click", coordinate: [10, 20] },
					{ action: "double_click", x: 5, y: 6 },
					{ action: "right_click", elementId: "el_2" },
					{ action: "keypress", keys: ["ctrl", "s"] },
					{ action: "key", text: "Return" },
					{ action: "hold_key", key: "shift", duration: 1.5 },
					{ action: "scroll", x: 1, y: 2, scroll_y: 240 },
					{ action: "scroll", scroll_direction: "up", scroll_amount: 5 },
					{ action: "wait", duration: 2 },
					{ action: "wait", ms: 7 },
					{ action: "wait" },
					{
						action: "left_click_drag",
						start_coordinate: [1, 1],
						coordinate: [9, 9],
					},
					{
						action: "drag",
						path: [
							{ x: 0, y: 0 },
							{ x: 3, y: 3 },
						],
					},
					{
						action: "mouse_move",
						target: { elementId: "el_1", x: null, y: null },
					},
					{ action: "OpenApp", appName: "Notes" },
					{ action: "zoom", regionBox: [10, 10, 110, 60] },
				],
			}),
		).toEqual({
			actions: [
				{ action: "screenshot" },
				{ action: "click", target: { x: 10, y: 20 } },
				{ action: "click", target: { x: 5, y: 6 }, count: 2 },
				{ action: "click", target: { elementId: "el_2" }, button: "right" },
				{ action: "key", key: "ctrl+s" },
				{ action: "key", key: "Return" },
				{ action: "holdKey", key: "shift", durationMs: 1500 },
				{
					action: "scroll",
					target: { x: 1, y: 2 },
					direction: "down",
					amount: 6,
				},
				{ action: "scroll", direction: "up", amount: 5 },
				{ action: "wait", durationMs: 2000 },
				{ action: "wait", durationMs: 7 },
				{ action: "wait", durationMs: 1000 },
				{ action: "drag", from: { x: 1, y: 1 }, to: { x: 9, y: 9 } },
				{ action: "drag", from: { x: 0, y: 0 }, to: { x: 3, y: 3 } },
				{ action: "move", target: { elementId: "el_1" } },
				{ action: "openApp", appName: "Notes" },
				{ action: "zoom", region: { x: 10, y: 10, width: 100, height: 50 } },
			],
		});
	});

	it("emits a flat, union-free schema Backboard accepts", () => {
		const schema = new ComputerTool().toJSONSchema().function.parameters;
		const json = JSON.stringify(schema);
		expect(schema.type).toBe("object");
		expect(json).not.toContain('"anyOf"');
		expect(json).not.toContain('"oneOf"');
		const actions = (schema.properties as Record<string, unknown>)
			.actions as Record<string, unknown>;
		const items = actions.items as Record<string, unknown>;
		const action = (items.properties as Record<string, unknown>)
			.action as Record<string, unknown>;
		expect(action.enum).toEqual([
			"screenshot",
			"zoom",
			"click",
			"move",
			"drag",
			"scroll",
			"type",
			"key",
			"holdKey",
			"wait",
			"openApp",
		]);
		expect(items.properties).toHaveProperty("region");
		expect(items.properties).toHaveProperty("direction");
	});

	it("describes the tool from one shared prompt in both profiles", () => {
		const tool = new ComputerTool();
		const shared = tool.prompt();
		const openai = tool.prompt({ profile: "openai" });
		expect(shared).toContain("screenSize space");
		expect(shared).toContain("Do not add a trailing screenshot");
		expect(openai).toContain("screenSize space");
		expect(openai).toContain("### Parameters");
	});
});

describe("ComputerTool gating", () => {
	it("is hidden until computer use is enabled", () => {
		const config = new Config({ env, argv: [] });
		const registry = new ToolRegistry([
			new ReadTool(),
			new ComputerTool(),
			new BrowserTool(),
		]);
		const names = () =>
			registry
				.toJSONSchemas(config.enabledTools, config.toolSchemaExcludedNames)
				.map((tool) => tool.function.name);

		expect(names()).toEqual(["read"]);
		expect(config.isToolEnabled("Computer")).toBe(false);
		config.enableComputerUse();
		expect(names()).toEqual(["read", "computer"]);
		expect(config.isToolEnabled("Computer")).toBe(true);
		config.enableBrowserUse();
		expect(names()).toEqual(["read", "computer", "browser"]);
	});

	it("parses /cua and /browser", () => {
		expect(parseCommand("/cua")).toEqual({ type: "cua" });
		expect(parseCommand("/browser")).toEqual({ type: "browser" });
	});

	it("adds the Computer notice to the system prompt only when enabled", () => {
		expect(getSystemPrompt()).not.toContain("- Computer:");
		expect(getSystemPrompt({ computerUseEnabled: true })).toContain(
			"- Computer:",
		);
		expect(getSystemPrompt({ browserUseEnabled: true })).toContain(
			"- Browser:",
		);
	});
});

describe("ComputerTool permissions", () => {
	const tool = new ComputerTool();

	it("treats observation-only batches as read-only", () => {
		expect(
			tool.isReadOnly({
				actions: [
					{ action: "screenshot" },
					{ action: "zoom", region: { x: 0, y: 0, width: 10, height: 10 } },
					{ action: "wait", durationMs: 1 },
					{ action: "move", target: { x: 1, y: 1 } },
				],
			}),
		).toBe(true);
		expect(
			tool.isReadOnly({
				actions: [{ action: "screenshot" }, { action: "type", text: "x" }],
			}),
		).toBe(false);
		expect(
			tool.isDestructive({ actions: [{ action: "key", key: "ENTER" }] }),
		).toBe(true);
	});

	it("summarizes the batch for the permission prompt", () => {
		expect(
			tool.summarizeInput({
				actions: [
					{ action: "click", target: { elementId: "el_3" } },
					{ action: "type", text: "hello world" },
					{ action: "key", key: "cmd+s" },
					{ action: "click", target: { x: 10, y: 20 }, count: 2 },
				],
			}),
		).toBe(
			'click el_3 · type "hello world" · key meta+S · double-click (10, 20)',
		);
	});

	it("flags credential-looking text", () => {
		expect(
			tool.permissionHint({
				actions: [{ action: "type", text: "sk-abcdefghijklmnop1234" }],
			}),
		).toContain("credential");
		expect(
			tool.permissionHint({ actions: [{ action: "type", text: "hello" }] }),
		).toBeUndefined();
	});
});

describe("ComputerRuntime batches", () => {
	it("returns one final observation carrying the only image", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "Button",
				name: "OK",
				bounds: { x: 10, y: 20, width: 100, height: 30 },
			},
		];
		const tool = makeTool(platform);
		const result = await tool.execute(
			{
				actions: [
					{ action: "openApp", appName: "Safari" },
					{ action: "type", text: "hello" },
					{ action: "key", key: "cmd+l" },
				],
			},
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(data.success).toBe(true);
		expect(data.os).toBe("darwin");
		expect(platform.actions.map((a) => a.kind)).toEqual([
			"openApp",
			"type",
			"key",
		]);
		expect(platform.actions[2]).toEqual({
			kind: "key",
			key: { key: "L", modifiers: ["meta"] },
		});
		expect(data.results).toHaveLength(3);
		expect(data.results.every((r) => r.success)).toBe(true);
		expect(data.observation?.__image_base64).toBeDefined();
		expect(data.observation?.elements[0]?.name).toBe("OK");
		expect(data.observation?.screenSize).toEqual({ width: 1440, height: 900 });
		expect(data.observation?.imageSize).toEqual({ width: 1280, height: 800 });
		expect(data.observation?.scale).toBeCloseTo(1280 / 1440, 5);
		expect(result.forLLM.split("__image_base64").length - 1).toBe(1);
		expect(platform.screenshots).toHaveLength(1);
		expect(platform.settles).toHaveLength(1);
		expect(platform.settles[0]?.timeoutMs).toBe(3000);
		expect(data.timing.totalMs).toBeGreaterThanOrEqual(0);
		expect(data.timing.settled).toBe(true);
		expect(result.title).toContain("Ran 3 actions");
	});

	it("does not settle or re-capture after a screenshot-only batch", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		const result = await tool.execute(
			{ actions: [{ action: "screenshot" }] },
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(data.observation?.__image_base64).toBeDefined();
		expect(platform.settles).toHaveLength(0);
		expect(platform.screenshots).toHaveLength(1);
		expect(result.title).toContain("screenshot");
	});

	it("drops a redundant trailing screenshot's duplicate image", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		const result = await tool.execute(
			{
				actions: [{ action: "type", text: "a" }, { action: "screenshot" }],
			},
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(platform.screenshots).toHaveLength(1);
		expect(platform.settles).toHaveLength(0);
		expect(data.observation).toBeDefined();
		expect(result.forLLM.split("__image_base64").length - 1).toBe(1);
	});

	it("stops at the first failure, marks the rest skipped, and still observes", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "Button",
				bounds: { x: 0, y: 0, width: 10, height: 10 },
			},
		];
		const tool = makeTool(platform);
		const result = await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "click", target: { elementId: "el_9" } },
					{ action: "type", text: "never" },
				],
			},
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(data.success).toBe(false);
		expect(data.stoppedAt).toBe(1);
		expect(data.results[1]?.error).toContain('Unknown elementId "el_9"');
		expect(data.results[2]).toMatchObject({ skipped: true, success: false });
		expect(platform.actions).toHaveLength(0);
		expect(data.observation).toBeDefined();
		expect(result.title).toBe("Failed click (2/3)");
	});

	it("continues past failures when stopOnError is false", async () => {
		const platform = new FakePlatform();
		platform.failNext = new Error("boom");
		const tool = makeTool(platform);
		const result = await tool.execute(
			{
				actions: [
					{ action: "openApp", appName: "A" },
					{ action: "openApp", appName: "B" },
				],
				stopOnError: false,
			},
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(data.results[0]?.error).toBe("boom");
		expect(data.results[1]?.success).toBe(true);
		expect(data.stoppedAt).toBeUndefined();
		expect(platform.actions).toHaveLength(1);
	});

	it("resolves element targets to centre points in point space", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "Button",
				bounds: { x: 10, y: 20, width: 100, height: 30 },
			},
		];
		const tool = makeTool(platform);
		await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{
						action: "click",
						target: { elementId: "el_1" },
						count: 2,
						modifiers: ["shift"],
					},
				],
			},
			ctx(),
		);
		expect(platform.actions[0]).toEqual({
			kind: "click",
			point: { x: 60, y: 35 },
			button: "left",
			count: 2,
			modifiers: ["shift"],
		});
	});

	it("refreshes element bounds after a state change inside the batch", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "TextField",
				name: "Name",
				bounds: { x: 0, y: 0, width: 100, height: 20 },
			},
			{
				id: "el_2",
				role: "Button",
				name: "Save",
				bounds: { x: 0, y: 40, width: 60, height: 20 },
			},
		];
		platform.refreshedElements = [
			{
				id: "el_7",
				role: "TextField",
				name: "Name",
				bounds: { x: 0, y: 0, width: 100, height: 20 },
			},
			{
				id: "el_8",
				role: "Button",
				name: "Save",
				bounds: { x: 200, y: 300, width: 60, height: 20 },
			},
		];
		const tool = makeTool(platform);
		await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "click", target: { elementId: "el_1" } },
					{ action: "type", text: "Ada" },
					{ action: "click", target: { elementId: "el_2" } },
				],
			},
			ctx(),
		);
		const clicks = platform.actions.filter((a) => a.kind === "click");
		expect(clicks[0]).toMatchObject({ point: { x: 50, y: 10 } });
		expect(clicks[1]).toMatchObject({ point: { x: 230, y: 310 } });
	});

	it("rejects coordinates before a screenshot and outside the screen", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		const first = await tool.execute(
			{ actions: [{ action: "click", target: { x: 1, y: 1 } }] },
			ctx(),
		);
		expect((first.data as ComputerQueueResult).results[0]?.error).toContain(
			"screenshot is required",
		);
		const second = await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "click", target: { x: 5000, y: 10 } },
				],
			},
			ctx(),
		);
		expect((second.data as ComputerQueueResult).results[1]?.error).toContain(
			"outside the 1440x900 screen",
		);
		expect(platform.actions).toHaveLength(0);
	});

	it("maps scroll and drag onto platform actions", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{
						action: "scroll",
						target: { x: 100, y: 100 },
						direction: "down",
						amount: 4,
					},
					{ action: "scroll", direction: "left" },
					{ action: "drag", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } },
					{ action: "holdKey", key: "shift", durationMs: 200 },
					{ action: "key", key: "DOWN", repeat: 3 },
				],
			},
			ctx(),
		);
		expect(platform.actions).toEqual([
			{ kind: "scroll", point: { x: 100, y: 100 }, dx: 0, dy: 4 },
			{ kind: "scroll", dx: -3, dy: 0 },
			{
				kind: "drag",
				from: { x: 1, y: 2 },
				to: { x: 3, y: 4 },
				button: "left",
			},
			{
				kind: "holdKey",
				key: { key: "SHIFT", modifiers: [] },
				durationMs: 200,
			},
			{ kind: "key", key: { key: "DOWN", modifiers: [] }, repeat: 3 },
		]);
	});

	it("zooms into a region without losing the full-screen elements", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "Button",
				bounds: { x: 0, y: 0, width: 10, height: 10 },
			},
		];
		const tool = makeTool(platform);
		const result = await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "zoom", region: { x: 10, y: 10, width: 200, height: 100 } },
				],
			},
			ctx(),
		);
		const data = result.data as ComputerQueueResult;
		expect(platform.screenshots[1]?.region).toEqual({
			x: 10,
			y: 10,
			width: 200,
			height: 100,
		});
		expect(data.observation?.region).toEqual({
			x: 10,
			y: 10,
			width: 200,
			height: 100,
		});
		expect(data.observation?.elements).toHaveLength(1);
		expect(data.observation?.screenSize).toEqual({ width: 1440, height: 900 });
		expect(platform.settles).toHaveLength(0);
	});

	it("runs wait without touching the platform and honours abort", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		const result = await tool.execute(
			{ actions: [{ action: "wait", durationMs: 1 }] },
			ctx(),
		);
		expect((result.data as ComputerQueueResult).results[0]?.summary).toBe(
			"Waited 1ms.",
		);
		expect(platform.actions).toEqual([]);

		const controller = new AbortController();
		const pending = tool.execute(
			{ actions: [{ action: "wait", durationMs: 5000 }] },
			makeContext(controller.signal),
		);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
	});

	it("disposes the platform with the tool", async () => {
		const platform = new FakePlatform();
		const tool = makeTool(platform);
		await tool.execute({ actions: [{ action: "screenshot" }] }, ctx());
		await tool.dispose();
		expect(platform.disposed).toBe(true);
	});
});

describe("computer keys", () => {
	it("normalizes chords, aliases, and objects", () => {
		expect(normalizeComputerKey("cmd+shift+t")).toEqual({
			key: "T",
			modifiers: ["meta", "shift"],
		});
		expect(normalizeComputerKey("Return")).toEqual({
			key: "ENTER",
			modifiers: [],
		});
		expect(normalizeComputerKey("ctrl++")).toEqual({
			key: "+",
			modifiers: ["control"],
		});
		expect(normalizeComputerKey("super+Page_Down")).toEqual({
			key: "PAGEDOWN",
			modifiers: ["meta"],
		});
		expect(
			normalizeComputerKey({ key: "a", modifiers: ["Option", "cmd", "meta"] }),
		).toEqual({
			key: "A",
			modifiers: ["alt", "meta"],
		});
		expect(normalizeComputerKey("F5")).toEqual({ key: "F5", modifiers: [] });
		expect(formatComputerKey(normalizeComputerKey("ctrl+shift+t"))).toBe(
			"control+shift+T",
		);
		expect(() => normalizeComputerKey("hyper+x")).toThrow(
			"Unsupported key modifier",
		);
		expect(() => normalizeComputerKey("  ")).toThrow("Key cannot be empty");
	});
});

describe("element refresh", () => {
	it("matches by role+name first, then by overlap", () => {
		const previous: AccessibilityElement[] = [
			{
				id: "el_1",
				role: "Button",
				name: "Save",
				bounds: { x: 0, y: 0, width: 10, height: 10 },
			},
			{
				id: "el_2",
				role: "TextField",
				bounds: { x: 50, y: 50, width: 10, height: 10 },
			},
			{
				id: "el_3",
				role: "Button",
				name: "Gone",
				bounds: { x: 90, y: 90, width: 5, height: 5 },
			},
		];
		const fresh: AccessibilityElement[] = [
			{
				id: "el_9",
				role: "TextField",
				bounds: { x: 55, y: 55, width: 12, height: 12 },
			},
			{
				id: "el_8",
				role: "Button",
				name: "Save",
				bounds: { x: 300, y: 0, width: 10, height: 10 },
			},
		];
		const refreshed = refreshElementBounds(previous, fresh);
		expect(refreshed[0]?.bounds).toEqual({
			x: 300,
			y: 0,
			width: 10,
			height: 10,
		});
		expect(refreshed[1]?.bounds).toEqual({
			x: 55,
			y: 55,
			width: 12,
			height: 12,
		});
		expect(refreshed[2]?.bounds).toEqual({ x: 90, y: 90, width: 5, height: 5 });
		expect(refreshed.map((e) => e.id)).toEqual(["el_1", "el_2", "el_3"]);
	});
});

describe("ComputerPaths", () => {
	it("uses the home Backboard screenshot directory", () => {
		const paths = new ComputerPaths("sess_test");
		expect(paths.screenshotDir).toContain(".backboard/screenshots/sess_test");
	});

	it("prunes a session to a byte budget, oldest first, keeping the newest", async () => {
		const root = await tempRoot();
		const paths = new ComputerPaths("sess_a", root);
		const files: string[] = [];
		for (let i = 0; i < 4; i++) {
			const path = await paths.nextScreenshotPath(
				"png",
				new Date(2026, 0, 1, 0, 0, i),
			);
			await writeFile(path, Buffer.alloc(100));
			files.push(path);
			await Bun.sleep(5);
		}
		const removed = await paths.pruneSession(250);
		expect(removed).toBe(2);
		expect(await Bun.file(files[0] as string).exists()).toBe(false);
		expect(await Bun.file(files[3] as string).exists()).toBe(true);
		expect(await paths.pruneSession(1)).toBe(1);
		expect(await Bun.file(files[3] as string).exists()).toBe(true);
	});

	it("prunes other sessions' directories older than the max age", async () => {
		const root = await tempRoot();
		const old = new ComputerPaths("sess_old", root);
		const mine = new ComputerPaths("sess_me", root);
		await writeFile(await old.nextScreenshotPath(), Buffer.alloc(1));
		await writeFile(await mine.nextScreenshotPath(), Buffer.alloc(1));
		expect(await mine.pruneOldSessions(1, Date.now() + 10_000)).toBe(1);
		expect(await Bun.file(join(root, "sess_me")).exists()).toBe(false); // directory, not file
		expect(
			await Array.fromAsync(
				new Bun.Glob("*").scan({ cwd: root, onlyFiles: false }),
			),
		).toEqual(["sess_me"]);
	});
});

describe("image headers", () => {
	it("reads PNG and JPEG dimensions", () => {
		expect(imageSize(tinyPng(), "png")).toEqual({ width: 1, height: 1 });
		expect(imageSize(tinyJpeg(), "jpeg")).toEqual({ width: 1, height: 1 });
		expect(() => imageSize(Buffer.from("nope"), "x")).toThrow(
			"not a valid PNG or JPEG",
		);
	});
});

function tinyPng(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6py3wAAAABJRU5ErkJggg==",
		"base64",
	);
}

function tinyJpeg(): Buffer {
	return Buffer.from(
		"/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=",
		"base64",
	);
}
