import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserHarnessPlatform } from "../src/core/browser/BrowserHarnessPlatform.ts";
import type { BrowserHarnessClient } from "../src/core/browser/BrowserHarnessSession.ts";
import { isUsablePageTarget } from "../src/core/browser/BrowserHarnessSession.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

class FakeBrowserClient implements BrowserHarnessClient {
	readonly calls: Array<{ method: string; params: Record<string, unknown> }> =
		[];

	async call<T>(
		method: string,
		params: Record<string, unknown> = {},
	): Promise<T> {
		this.calls.push({ method, params });
		if (method === "Page.captureScreenshot") {
			return { data: tinyPng().toString("base64") } as T;
		}
		if (method === "Page.getLayoutMetrics") {
			return {
				cssVisualViewport: { clientWidth: 0.5, clientHeight: 0.5 },
			} as T;
		}
		if (method === "Runtime.evaluate") {
			return {
				result: {
					value: {
						title: "Test page",
						elements: [
							{
								role: "button",
								name: "Save",
								bounds: { x: 10, y: 20, width: 40, height: 20 },
								enabled: true,
								focused: false,
							},
						],
					},
				},
			} as T;
		}
		return {} as T;
	}
}

describe("BrowserHarnessPlatform", () => {
	it("filters debuggable page targets", () => {
		expect(
			isUsablePageTarget({
				id: "1",
				type: "page",
				url: "https://example.test",
			}),
		).toBe(true);
		expect(
			isUsablePageTarget({ id: "2", type: "page", url: "chrome://version" }),
		).toBe(false);
		expect(
			isUsablePageTarget({ id: "3", type: "page", url: "devtools://tools" }),
		).toBe(false);
		expect(
			isUsablePageTarget({ id: "4", type: "service_worker", url: "https://x" }),
		).toBe(false);
	});

	it("captures screenshots and maps DOM elements to screenshot coordinates", async () => {
		const client = new FakeBrowserClient();
		const platform = new BrowserHarnessPlatform(client);
		const dir = await mkdtemp(join(tmpdir(), "browser-platform-"));
		tempDirs.push(dir);

		const shot = await platform.screenshot(
			join(dir, "screen.png"),
			new AbortController().signal,
		);
		const snapshot = await platform.accessibilitySnapshot(
			new AbortController().signal,
		);

		expect(shot.screenSize).toEqual({ width: 1, height: 1 });
		expect(snapshot.windowTitle).toBe("Test page");
		expect(snapshot.elements[0]).toMatchObject({
			id: "el_1",
			role: "button",
			name: "Save",
			bounds: { x: 20, y: 40, width: 80, height: 40 },
		});
	});

	it("dispatches browser navigation, typing, keys, and scaled clicks", async () => {
		const client = new FakeBrowserClient();
		const platform = new BrowserHarnessPlatform(client);
		const dir = await mkdtemp(join(tmpdir(), "browser-platform-"));
		tempDirs.push(dir);
		await platform.screenshot(
			join(dir, "screen.png"),
			new AbortController().signal,
		);

		await platform.navigate(
			"https://example.test",
			new AbortController().signal,
		);
		await platform.execute(
			{ kind: "type", text: "hello" },
			new AbortController().signal,
		);
		await platform.execute(
			{ kind: "key", key: { key: "ENTER", modifiers: ["meta"] } },
			new AbortController().signal,
		);
		await platform.execute(
			{ kind: "click", point: { x: 20, y: 40 }, button: "left" },
			new AbortController().signal,
		);

		expect(client.calls).toContainEqual({
			method: "Page.navigate",
			params: { url: "https://example.test" },
		});
		expect(client.calls).toContainEqual({
			method: "Input.insertText",
			params: { text: "hello" },
		});
		expect(client.calls).toContainEqual({
			method: "Input.dispatchKeyEvent",
			params: {
				type: "keyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				modifiers: 4,
			},
		});
		expect(client.calls).toContainEqual({
			method: "Input.dispatchMouseEvent",
			params: {
				type: "mousePressed",
				x: 10,
				y: 20,
				button: "left",
				clickCount: 1,
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
