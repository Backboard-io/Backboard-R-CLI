import { describe, expect, it } from "bun:test";
import { BrowserRuntime } from "../src/core/browser/BrowserRuntime.ts";
import type { BrowserPlatform } from "../src/core/browser/BrowserTypes.ts";
import type {
	AccessibilitySnapshot,
	PlatformAction,
} from "../src/core/platform/index.ts";
import { BrowserTool } from "../src/tools/BrowserTool.tsx";
import { makeContext } from "./helpers.ts";

class FakeBrowserPlatform implements BrowserPlatform {
	readonly actions: Array<{ kind: string; value?: unknown }> = [];

	async navigate(url: string): Promise<void> {
		this.actions.push({ kind: "navigate", value: url });
	}

	async screenshot(
		path: string,
		_signal: AbortSignal,
	): Promise<{
		path: string;
		bytes: Buffer;
		screenSize: { width: number; height: number };
	}> {
		this.actions.push({ kind: "screenshot" });
		return { path, bytes: tinyPng(), screenSize: { width: 1, height: 1 } };
	}

	async fitPngForPayload(input: {
		bytes: Buffer;
		screenSize: { width: number; height: number };
		path: string;
		maxBytes: number;
		signal: AbortSignal;
	}): Promise<{
		bytes: Buffer;
		imageSize: { width: number; height: number };
		scale: number;
		compressed: boolean;
	}> {
		return {
			bytes: input.bytes,
			imageSize: input.screenSize,
			scale: 1,
			compressed: false,
		};
	}

	async accessibilitySnapshot(
		_signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		return {
			windowTitle: "Fake Browser",
			elements: [
				{
					id: "el_1",
					role: "button",
					name: "Run",
					bounds: { x: 10, y: 20, width: 40, height: 20 },
				},
			],
		};
	}

	async execute(action: PlatformAction, _signal: AbortSignal): Promise<void> {
		this.actions.push({ kind: action.kind, value: action });
	}
}

describe("BrowserTool", () => {
	it("accepts browser actions and rejects desktop-only actions", () => {
		const tool = new BrowserTool();
		expect(
			tool.parseInput({
				actions: [
					{ action: "navigate", url: "https://example.test" },
					{ type: "wait", ms: 1 },
					{ action: "click", elementId: "el_1" },
					{ action: "click", x: 10, y: 20 },
					{ action: "key", key: "k" },
					{ action: "key", key: "L", modifiers: ["shift"] },
				],
			}),
		).toEqual({
			actions: [
				{ action: "navigate", url: "https://example.test" },
				{ action: "wait", durationMs: 1 },
				{ action: "click", target: { elementId: "el_1" } },
				{ action: "click", target: { x: 10, y: 20 } },
				{ action: "key", key: "k" },
				{ action: "key", key: "L", modifiers: ["shift"] },
			],
		});
		expect(() =>
			tool.parseInput({ actions: [{ action: "openApp", appName: "Safari" }] }),
		).toThrow();
		expect(() => tool.parseInput({ actions: [{ action: "click" }] })).toThrow();
		expect(() =>
			tool.parseInput({ actions: [{ action: "key", key: { key: "k" } }] }),
		).toThrow();
	});

	it("emits a Browser tool schema", () => {
		const schema = new BrowserTool().toJSONSchema().function.parameters;
		expect(new BrowserTool().toJSONSchema().function.name).toBe("browser");
		expect(schema.type).toBe("object");
		expect(schema).toHaveProperty("properties");
		expect(schema).not.toHaveProperty("anyOf");
		expect(schema).not.toHaveProperty("oneOf");
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
		).toEqual(["screenshot", "navigate", "click", "type", "key", "wait"]);
		expect(items.properties as Record<string, unknown>).toHaveProperty("url");
		expect(items.properties as Record<string, unknown>).toHaveProperty(
			"elementId",
		);
		expect(items.properties as Record<string, unknown>).toHaveProperty("x");
		expect(items.properties as Record<string, unknown>).toHaveProperty("y");
		expect(items.properties as Record<string, unknown>).toHaveProperty("key");
		expect(items.properties as Record<string, unknown>).toHaveProperty(
			"modifiers",
		);
	});

	it("rejects string actions instead of normalizing command text", () => {
		const tool = new BrowserTool();
		expect(() =>
			tool.parseInput({
				actions: [
					"navigate https://www.youtube.com/results?search_query=latest+music+video",
				],
			}),
		).toThrow();
	});

	it("executes navigation and element clicks through the browser platform", async () => {
		const platform = new FakeBrowserPlatform();
		const tool = new BrowserTool(new BrowserRuntime({ platform }));
		const result = await tool.execute(
			{
				actions: [
					{ action: "navigate", url: "https://example.test" },
					{ action: "click", target: { elementId: "el_1" } },
				],
			},
			makeContext(new AbortController().signal),
		);

		expect(result.data).toMatchObject({ success: true });
		expect(result.forLLM).toContain('"windowTitle":"Fake Browser"');
		expect(platform.actions[0]).toEqual({
			kind: "navigate",
			value: "https://example.test",
		});
		expect(platform.actions.at(-1)).toMatchObject({
			kind: "screenshot",
		});
		expect(platform.actions).toContainEqual({
			kind: "click",
			value: {
				kind: "click",
				point: { x: 30, y: 30 },
				button: "left",
			},
		});
	});
});

function tinyPng(): Buffer {
	return Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l6py3wAAAABJRU5ErkJggg==",
		"base64",
	);
}
