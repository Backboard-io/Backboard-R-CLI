import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ComputerPaths } from "../src/core/computer/ComputerPaths.ts";
import { ComputerRuntime } from "../src/core/computer/ComputerRuntime.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	ImagePayload,
	Platform,
	PlatformAction,
	ScreenSize,
	ScreenshotCapture,
} from "../src/core/platform/index.ts";
import { createPlatform } from "../src/core/platform/index.ts";
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
	actions: PlatformAction[] = [];
	elements: AccessibilityElement[] = [];
	appName = "FakeApp";
	processId = 123;
	windowTitle = "Fake Window";

	async screenshot(path: string): Promise<ScreenshotCapture> {
		const size: ScreenSize = { width: 1, height: 1 };
		return {
			path,
			bytes: tinyPng(),
			screenSize: size,
		};
	}

	async execute(action: PlatformAction): Promise<void> {
		this.actions.push(action);
	}

	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		return {
			appName: this.appName,
			processId: this.processId,
			windowTitle: this.windowTitle,
			elements: this.elements,
		};
	}

	async fitPngForPayload(input: {
		bytes: Buffer;
		screenSize: ScreenSize;
	}): Promise<ImagePayload> {
		return {
			bytes: input.bytes,
			imageSize: input.screenSize,
			scale: 1,
			compressed: false,
		};
	}
}

describe("ComputerTool", () => {
	it("accepts queued actions and rejects single-action input", () => {
		const tool = new ComputerTool();
		expect(
			tool.parseInput({
				actions: [{ action: "screenshot" }],
			}),
		).toEqual({
			actions: [{ action: "screenshot" }],
		});
		expect(
			tool.parseInput({
				actions: [
					{ action: "screenshot" },
					{ action: "openApp", appName: "Safari" },
				],
			}),
		).toBeDefined();
		expect(() => tool.parseInput({ action: "screenshot" })).toThrow();
		expect(() =>
			tool.parseInput({
				actions: [{ action: "click", target: { elementId: "" } }],
			}),
		).toThrow();
	});

	it("tolerates type as an action alias inside queued actions", () => {
		const tool = new ComputerTool();
		expect(
			tool.parseInput({
				actions: [{ type: "screenshot" }],
			}),
		).toEqual({
			actions: [{ action: "screenshot" }],
		});
	});

	it("normalizes common model variants before validation", () => {
		const tool = new ComputerTool();
		expect(
			tool.parseInput({
				actions: [
					"screenshot",
					{ type: "key", key: "META+SPACE" },
					{ type: "key", key: { key: "META+L" } },
					{ type: "key", key: { key: "A", modifiers: ["CMD", "SHIFT"] } },
					{ type: "wait", ms: 4000 },
				],
			}),
		).toEqual({
			actions: [
				{ action: "screenshot" },
				{ action: "key", key: { key: "SPACE", modifiers: ["meta"] } },
				{ action: "key", key: { key: "L", modifiers: ["meta"] } },
				{
					action: "key",
					key: { key: "A", modifiers: ["meta", "shift"] },
				},
				{ action: "wait", durationMs: 4000 },
			],
		});
	});

	it("emits a Backboard-compatible root object schema", () => {
		const schema = new ComputerTool().toJSONSchema().function.parameters;
		expect(schema.type).toBe("object");
		expect(schema).toHaveProperty("properties");
		expect(schema).not.toHaveProperty("anyOf");
		expect(
			(schema.properties as Record<string, unknown>).action,
		).toBeUndefined();
		expect(
			(schema.properties as Record<string, unknown>).actions,
		).toBeDefined();
		const actions = (schema.properties as Record<string, unknown>)
			.actions as Record<string, unknown>;
		const items = actions.items as Record<string, unknown>;
		expect(items.type).toBe("object");
		expect(items).not.toHaveProperty("anyOf");
		expect(items).not.toHaveProperty("oneOf");
		expect(
			(
				(items.properties as Record<string, unknown>).action as Record<
					string,
					unknown
				>
			).enum,
		).toContain("openApp");
		expect(
			(
				(items.properties as Record<string, unknown>).action as Record<
					string,
					unknown
				>
			).enum,
		).not.toContain("scroll");
		expect(
			(
				(items.properties as Record<string, unknown>).target as Record<
					string,
					unknown
				>
			).description,
		).toContain("target.elementId");
		expect(items.properties as Record<string, unknown>).not.toHaveProperty(
			"direction",
		);
		expect(items.properties as Record<string, unknown>).not.toHaveProperty(
			"from",
		);
	});

	it("is hidden until computer use is enabled", () => {
		const config = new Config({ env, argv: [] });
		const registry = new ToolRegistry([
			new ReadTool(),
			new ComputerTool(),
			new BrowserTool(),
		]);

		expect(
			registry
				.toJSONSchemas(config.enabledTools, config.toolSchemaExcludedNames)
				.map((tool) => tool.function.name),
		).toEqual(["read"]);
		expect(config.isToolEnabled("Computer")).toBe(false);

		config.enableComputerUse();
		expect(
			registry
				.toJSONSchemas(config.enabledTools, config.toolSchemaExcludedNames)
				.map((tool) => tool.function.name),
		).toEqual(["read", "computer"]);
		expect(config.isToolEnabled("Computer")).toBe(true);
		expect(config.isToolEnabled("Browser")).toBe(false);

		config.enableBrowserUse();
		expect(
			registry
				.toJSONSchemas(config.enabledTools, config.toolSchemaExcludedNames)
				.map((tool) => tool.function.name),
		).toEqual(["read", "computer", "browser"]);
		expect(config.isToolEnabled("Browser")).toBe(true);
	});

	it("parses /cua", () => {
		expect(parseCommand("/cua")).toEqual({ type: "cua" });
	});

	it("parses /browser", () => {
		expect(parseCommand("/browser")).toEqual({ type: "browser" });
	});

	it("adds Computer to the system prompt only when enabled", () => {
		expect(getSystemPrompt()).not.toContain("- Computer:");
		expect(getSystemPrompt({ computerUseEnabled: true })).toContain(
			"- Computer:",
		);
	});

	it("adds Browser to the system prompt only when enabled", () => {
		expect(getSystemPrompt()).not.toContain("- Browser:");
		expect(getSystemPrompt({ browserUseEnabled: true })).toContain(
			"- Browser:",
		);
	});

	it("runs screenshot and queued actions through the runtime", async () => {
		const platform = new FakePlatform();
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		const first = await tool.execute(
			{ actions: [{ action: "screenshot" }] },
			ctx,
		);
		expect(first.forLLM).toContain("__image_base64");

		const second = await tool.execute(
			{
				actions: [
					{ action: "openApp", appName: "Safari" },
					{ action: "type", text: "hello" },
				],
			},
			ctx,
		);
		expect(second.data).toMatchObject({ success: true });
		expect(second.forLLM).toContain("Captured updated screenshot");
		expect(second.forLLM).toContain("__image_base64");
		expect(platform.actions.map((action) => action.kind)).toEqual([
			"openApp",
			"type",
		]);
	});

	it("includes platform accessibility elements in screenshot observations", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				appName: "Mail",
				processId: 123,
				windowTitle: "Inbox",
				role: "button",
				name: "Compose",
				bounds: { x: 10, y: 20, width: 100, height: 30 },
			},
		];
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		const result = await tool.execute(
			{ actions: [{ action: "screenshot" }] },
			ctx,
		);

		expect(result.forLLM).toContain('"id":"el_1"');
		expect(result.forLLM).toContain('"appName":"FakeApp"');
		expect(result.forLLM).toContain('"windowTitle":"Fake Window"');
		expect(result.forLLM).toContain('"appName":"Mail"');
		expect(result.forLLM).toContain('"windowTitle":"Inbox"');
		expect(result.forLLM).toContain('"name":"Compose"');
	});

	it("resolves element targets to platform click coordinates", async () => {
		const platform = new FakePlatform();
		platform.elements = [
			{
				id: "el_1",
				role: "button",
				bounds: { x: 10, y: 20, width: 100, height: 30 },
			},
		];
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		await tool.execute(
			{
				actions: [
					{ action: "screenshot" },
					{ action: "click", target: { elementId: "el_1" } },
				],
			},
			ctx,
		);

		expect(platform.actions[0]).toEqual({
			kind: "click",
			point: { x: 60, y: 35 },
			button: "left",
		});
	});

	it("runs wait actions without platform execution", async () => {
		const platform = new FakePlatform();
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		const result = await tool.execute(
			{ actions: [{ action: "wait", durationMs: 1 }] },
			ctx,
		);

		expect(result.data).toMatchObject({ success: true });
		expect(result.forLLM).toContain("Waited 1ms");
		expect(platform.actions).toEqual([]);
	});

	it("passes canonical key modifiers to platform execution", async () => {
		const platform = new FakePlatform();
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		await tool.execute(
			{
				actions: [{ action: "key", key: { key: "L", modifiers: ["meta"] } }],
			},
			ctx,
		);

		expect(platform.actions[0]).toEqual({
			kind: "key",
			key: { key: "L", modifiers: ["meta"] },
		});
	});

	it("normalizes canonical key objects before platform execution", async () => {
		const platform = new FakePlatform();
		const tool = new ComputerTool(new ComputerRuntime({ platform }));
		const ctx = makeContext(new AbortController().signal, new EventBus());

		await tool.execute(
			{ actions: [{ action: "key", key: { key: "l" } }] },
			ctx,
		);

		expect(platform.actions[0]).toEqual({
			kind: "key",
			key: { key: "L", modifiers: [] },
		});
	});

	it("rejects coordinate actions before a screenshot", async () => {
		const tool = new ComputerTool(
			new ComputerRuntime({ platform: new FakePlatform() }),
		);
		const ctx = makeContext(new AbortController().signal);

		const result = await tool.execute(
			{ actions: [{ action: "click", target: { x: 1, y: 1 } }] },
			ctx,
		);

		expect(result.forLLM).toContain("fresh screenshot is required");
	});

	it("uses the home Backboard screenshot directory", async () => {
		const paths = new ComputerPaths("sess_test");
		expect(paths.screenshotDir).toContain(".backboard/screenshots/sess_test");
	});

	it("compresses oversized PNG screenshots before payload encoding", async () => {
		if (process.platform !== "darwin") return;
		const dir = await mkdtemp(join(tmpdir(), "cua-test-"));
		tempDirs.push(dir);
		const path = join(dir, "screen.png");
		const bytes = tinyPng();
		await writeFile(path, bytes);

		const payload = await createPlatform().fitPngForPayload({
			path,
			bytes: Buffer.concat([bytes, Buffer.alloc(1_600_000)]),
			screenSize: { width: 2000, height: 2000 },
			maxBytes: 1_500_000,
			signal: new AbortController().signal,
		});

		expect(payload.bytes.byteLength).toBeLessThanOrEqual(1_500_000);
		expect(payload.compressed).toBe(true);
	});
});

function tinyPng(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6py3wAAAABJRU5ErkJggg==",
		"base64",
	);
}
