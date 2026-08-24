import { writeFile } from "node:fs/promises";
import { imageSize as pngSize } from "../platform/png.ts";
import type { PlatformKey, ScreenBounds } from "../platform/types.ts";
import {
	type BrowserHarnessClient,
	BrowserHarnessSession,
} from "./BrowserHarnessSession.ts";
import {
	type BrowserAccessibilityElement as AccessibilityElement,
	type BrowserAccessibilitySnapshot,
	type BrowserPlatformAction,
	BrowserPlatformBase,
	type BrowserScreenshotCapture,
} from "./BrowserPlatformBase.ts";
import type { BrowserPlatform } from "./BrowserTypes.ts";

interface CaptureResult {
	data?: string;
}

interface LayoutMetricsResult {
	cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
	cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
}

interface RuntimeEvaluateResult {
	result?: {
		value?: unknown;
	};
}

interface DomElementSnapshot {
	role?: unknown;
	name?: unknown;
	value?: unknown;
	enabled?: unknown;
	focused?: unknown;
	bounds?: unknown;
}

export class BrowserHarnessPlatform
	extends BrowserPlatformBase
	implements BrowserPlatform
{
	private readonly client: BrowserHarnessClient;
	private screenshotToCssScale = 1;

	constructor(client: BrowserHarnessClient = new BrowserHarnessSession()) {
		super();
		this.client = client;
	}

	async screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<BrowserScreenshotCapture> {
		await this.client.call("Page.enable", {}, signal);
		const [shot, metrics] = await Promise.all([
			this.client.call<CaptureResult>(
				"Page.captureScreenshot",
				{ format: "png", fromSurface: true },
				signal,
			),
			this.client.call<LayoutMetricsResult>(
				"Page.getLayoutMetrics",
				{},
				signal,
			),
		]);
		if (typeof shot.data !== "string") {
			throw new Error("Browser screenshot did not include image data");
		}
		const bytes = Buffer.from(shot.data, "base64");
		await writeFile(path, bytes);
		const size = pngSize(bytes, "browser screenshot");
		const cssWidth =
			metrics.cssVisualViewport?.clientWidth ??
			metrics.cssLayoutViewport?.clientWidth;
		this.screenshotToCssScale =
			typeof cssWidth === "number" && cssWidth > 0 ? size.width / cssWidth : 1;
		return { path, bytes, screenSize: size };
	}

	override async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<BrowserAccessibilitySnapshot> {
		const result = await this.client.call<RuntimeEvaluateResult>(
			"Runtime.evaluate",
			{
				expression: DOM_SNAPSHOT_SCRIPT,
				returnByValue: true,
				awaitPromise: false,
			},
			signal,
		);
		const value = result.result?.value;
		if (!value || typeof value !== "object") return { elements: [] };
		const raw = value as Record<string, unknown>;
		const elements = Array.isArray(raw.elements)
			? raw.elements.map((item, index) => this.toElement(item, index))
			: [];
		return {
			appName: "Browser",
			windowTitle:
				typeof raw.title === "string" && raw.title ? raw.title : undefined,
			elements: elements.filter((item): item is AccessibilityElement => !!item),
		};
	}

	async execute(
		action: BrowserPlatformAction,
		signal: AbortSignal,
	): Promise<void> {
		switch (action.kind) {
			case "openApp":
				if (/^(chrome|chromium|browser)$/i.test(action.appName)) return;
				throw new Error("Browser tool cannot open desktop applications.");
			case "type":
				await this.client.call(
					"Input.insertText",
					{ text: action.text },
					signal,
				);
				return;
			case "key":
				await this.key(action.key, signal);
				return;
			case "click":
				await this.click(
					action.point.x / this.screenshotToCssScale,
					action.point.y / this.screenshotToCssScale,
					action.button,
					signal,
				);
				return;
		}
	}

	async navigate(url: string, signal: AbortSignal): Promise<void> {
		await this.client.call("Page.enable", {}, signal);
		await this.client.call("Page.navigate", { url }, signal);
	}

	private async click(
		x: number,
		y: number,
		button: "left" | "right" | "middle",
		signal: AbortSignal,
	): Promise<void> {
		const cdpButton = button === "middle" ? "middle" : button;
		await this.client.call(
			"Input.dispatchMouseEvent",
			{ type: "mousePressed", x, y, button: cdpButton, clickCount: 1 },
			signal,
		);
		await this.client.call(
			"Input.dispatchMouseEvent",
			{ type: "mouseReleased", x, y, button: cdpButton, clickCount: 1 },
			signal,
		);
	}

	private async key(key: PlatformKey, signal: AbortSignal): Promise<void> {
		const code = keyCode(key.key);
		const modifiers = modifierMask(key.modifiers);
		await this.client.call(
			"Input.dispatchKeyEvent",
			{
				type: "keyDown",
				key: code.key,
				code: code.code,
				windowsVirtualKeyCode: code.windowsVirtualKeyCode,
				modifiers,
			},
			signal,
		);
		await this.client.call(
			"Input.dispatchKeyEvent",
			{
				type: "keyUp",
				key: code.key,
				code: code.code,
				windowsVirtualKeyCode: code.windowsVirtualKeyCode,
				modifiers,
			},
			signal,
		);
	}

	private toElement(
		value: unknown,
		index: number,
	): AccessibilityElement | null {
		if (!value || typeof value !== "object") return null;
		const raw = value as DomElementSnapshot;
		const bounds = parseBounds(raw.bounds, this.screenshotToCssScale);
		if (!bounds) return null;
		return {
			id: `el_${index + 1}`,
			appName: "Browser",
			role: typeof raw.role === "string" ? raw.role : "element",
			name: typeof raw.name === "string" ? raw.name : undefined,
			value: typeof raw.value === "string" ? raw.value : undefined,
			bounds,
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			focused: typeof raw.focused === "boolean" ? raw.focused : undefined,
		};
	}
}

function parseBounds(value: unknown, scale: number): ScreenBounds | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const x = numberValue(raw.x);
	const y = numberValue(raw.y);
	const width = numberValue(raw.width);
	const height = numberValue(raw.height);
	if (
		x === undefined ||
		y === undefined ||
		width === undefined ||
		height === undefined
	) {
		return undefined;
	}
	return {
		x: x * scale,
		y: y * scale,
		width: width * scale,
		height: height * scale,
	};
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function modifierMask(modifiers: PlatformKey["modifiers"]): number {
	let mask = 0;
	for (const modifier of modifiers) {
		if (modifier === "alt") mask |= 1;
		if (modifier === "control") mask |= 2;
		if (modifier === "meta") mask |= 4;
		if (modifier === "shift") mask |= 8;
	}
	return mask;
}

function keyCode(key: string): {
	key: string;
	code: string;
	windowsVirtualKeyCode: number;
} {
	const mapped = KEY_CODES[key.toUpperCase()];
	if (mapped) return mapped;
	if (key.length === 1) {
		const upper = key.toUpperCase();
		return {
			key,
			code: `Key${upper}`,
			windowsVirtualKeyCode: upper.charCodeAt(0),
		};
	}
	throw new Error(`Unsupported browser key: ${key}`);
}

const KEY_CODES: Record<
	string,
	{ key: string; code: string; windowsVirtualKeyCode: number }
> = {
	ENTER: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
	TAB: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
	SPACE: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
	ESC: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
	BACKSPACE: {
		key: "Backspace",
		code: "Backspace",
		windowsVirtualKeyCode: 8,
	},
	DELETE: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
	UP: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
	DOWN: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
	LEFT: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
	RIGHT: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
	HOME: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
	END: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
	PAGEUP: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
	PAGEDOWN: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

const DOM_SNAPSHOT_SCRIPT = `(() => {
	const selectors = [
		"a[href]",
		"button",
		"input",
		"textarea",
		"select",
		"[role]",
		"[onclick]",
		"[contenteditable='true']",
		"[tabindex]:not([tabindex='-1'])"
	];
	const elements = [];
	const seen = new Set();
	for (const el of document.querySelectorAll(selectors.join(","))) {
		if (!(el instanceof HTMLElement) || seen.has(el)) continue;
		seen.add(el);
		const rect = el.getBoundingClientRect();
		const style = window.getComputedStyle(el);
		if (rect.width <= 0 || rect.height <= 0 || style.visibility === "hidden" || style.display === "none") continue;
		const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim().slice(0, 160);
		elements.push({
			role: el.getAttribute("role") || el.tagName.toLowerCase(),
			name: text || undefined,
			value: "value" in el ? String(el.value).slice(0, 160) : undefined,
			enabled: !("disabled" in el && el.disabled),
			focused: document.activeElement === el,
			bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
		});
		if (elements.length >= 120) break;
	}
	return { title: document.title, url: location.href, elements };
})()`;
