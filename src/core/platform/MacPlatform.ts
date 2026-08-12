import { readFile } from "node:fs/promises";
import { BasePlatform } from "./BasePlatform.ts";
import { pngSize, resizeWithCandidates } from "./png.ts";
import { run, runWithOutput } from "./process.ts";
import type {
	AccessibilitySnapshot,
	ImagePayload,
	PlatformAction,
	PlatformKey,
	ResizePngInput,
	ScreenshotCapture,
} from "./types.ts";

export class MacPlatform extends BasePlatform {
	async screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		await run("screencapture", ["-x", path], signal);
		const bytes = await readFile(path);
		const size = pngSize(bytes, "screenshot");
		return { path, bytes, screenSize: size };
	}

	override async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		try {
			const output = await runWithOutput(
				"swift",
				["-e", MAC_ACCESSIBILITY_SCRIPT],
				signal,
			);
			const parsed = JSON.parse(output) as AccessibilitySnapshot;
			return {
				appName:
					typeof parsed.appName === "string" ? parsed.appName : undefined,
				processId:
					typeof parsed.processId === "number" ? parsed.processId : undefined,
				windowTitle:
					typeof parsed.windowTitle === "string"
						? parsed.windowTitle
						: undefined,
				elements: Array.isArray(parsed.elements) ? parsed.elements : [],
			};
		} catch {
			return { elements: [] };
		}
	}

	async execute(action: PlatformAction, signal: AbortSignal): Promise<void> {
		switch (action.kind) {
			case "openApp":
				await run("open", ["-a", action.appName], signal);
				return;
			case "type":
				await run(
					"osascript",
					[
						"-e",
						`tell application "System Events" to keystroke ${appleScriptString(action.text)}`,
					],
					signal,
				);
				return;
			case "key":
				await run("osascript", ["-e", macKeyScript(action.key)], signal);
				return;
			case "click":
				await run(
					"osascript",
					[
						"-e",
						`tell application "System Events" to click at {${Math.round(action.point.x)}, ${Math.round(action.point.y)}}`,
					],
					signal,
				);
				return;
		}
	}

	protected override async resizePng(
		input: ResizePngInput,
	): Promise<ImagePayload | null> {
		return resizeWithCandidates(input, async (width, out) => {
			await run(
				"sips",
				["-s", "format", "png", "-Z", String(width), input.path, "--out", out],
				input.signal,
			);
		});
	}
}

const MAC_ACCESSIBILITY_SCRIPT = `
import AppKit
import ApplicationServices
import Foundation

let maxElements = 120
let maxDepth = 6
var elements: [[String: Any]] = []
var appName: String?
var processId: Int?
var windowTitle: String?

func stringAttr(_ element: AXUIElement, _ attr: CFString) -> String? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, attr, &value) == .success,
		let raw = value
	else { return nil }
	if let text = raw as? String, !text.isEmpty {
		return String(text.prefix(160))
	}
	return nil
}

func boolAttr(_ element: AXUIElement, _ attr: CFString) -> Bool? {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, attr, &value) == .success,
		let raw = value
	else { return nil }
	return raw as? Bool
}

func bounds(_ element: AXUIElement) -> [String: Double]? {
	var posRef: CFTypeRef?
	var sizeRef: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
		AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
		let pos = posRef,
		let size = sizeRef,
		CFGetTypeID(pos) == AXValueGetTypeID(),
		CFGetTypeID(size) == AXValueGetTypeID()
	else { return nil }
	var point = CGPoint.zero
	var cgSize = CGSize.zero
	AXValueGetValue(pos as! AXValue, .cgPoint, &point)
	AXValueGetValue(size as! AXValue, .cgSize, &cgSize)
	guard cgSize.width > 0, cgSize.height > 0 else { return nil }
	return [
		"x": point.x,
		"y": point.y,
		"width": cgSize.width,
		"height": cgSize.height,
	]
}

func children(_ element: AXUIElement) -> [AXUIElement] {
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
		let array = value as? [AXUIElement]
	else { return [] }
	return array
}

func collect(_ element: AXUIElement, depth: Int) {
	if elements.count >= maxElements || depth > maxDepth { return }
	let role = stringAttr(element, kAXRoleAttribute as CFString) ?? "element"
	let name =
		stringAttr(element, kAXTitleAttribute as CFString) ??
		stringAttr(element, kAXDescriptionAttribute as CFString) ??
		stringAttr(element, kAXValueAttribute as CFString)
	if let b = bounds(element) {
		var item: [String: Any] = [
			"id": "el_\\(elements.count + 1)",
			"role": role,
			"bounds": b,
		]
		if let appName { item["appName"] = appName }
		if let processId { item["processId"] = processId }
		if let windowTitle { item["windowTitle"] = windowTitle }
		if let name { item["name"] = name }
		if let value = stringAttr(element, kAXValueAttribute as CFString) {
			item["value"] = value
		}
		if let enabled = boolAttr(element, kAXEnabledAttribute as CFString) {
			item["enabled"] = enabled
		}
		if let focused = boolAttr(element, kAXFocusedAttribute as CFString) {
			item["focused"] = focused
		}
		elements.append(item)
	}
	for child in children(element) {
		collect(child, depth: depth + 1)
	}
}

if let app = NSWorkspace.shared.frontmostApplication {
	appName = app.localizedName ?? app.bundleIdentifier ?? app.bundleURL?.lastPathComponent
	processId = Int(app.processIdentifier)
	let root = AXUIElementCreateApplication(app.processIdentifier)
	windowTitle = stringAttr(root, kAXTitleAttribute as CFString)
	if windowTitle == nil {
		var focusedWindow: CFTypeRef?
		if AXUIElementCopyAttributeValue(root, kAXFocusedWindowAttribute as CFString, &focusedWindow) == .success,
			let window = focusedWindow,
			CFGetTypeID(window) == AXUIElementGetTypeID()
		{
			windowTitle = stringAttr(window as! AXUIElement, kAXTitleAttribute as CFString)
		}
	}
	collect(root, depth: 0)
}

var payload: [String: Any] = ["elements": elements]
if let appName { payload["appName"] = appName }
if let processId { payload["processId"] = processId }
if let windowTitle { payload["windowTitle"] = windowTitle }
let data = try JSONSerialization.data(withJSONObject: payload)
print(String(data: data, encoding: .utf8)!)
`;

function macKeyScript(parsed: PlatformKey): string {
	const modifierSuffix =
		parsed.modifiers.length > 0
			? ` using {${parsed.modifiers
					.map(macModifier)
					.map((m) => `${m} down`)
					.join(", ")}}`
			: "";
	const keyCode = MAC_KEY_CODES[parsed.key];
	if (keyCode !== undefined) {
		return `tell application "System Events" to key code ${keyCode}${modifierSuffix}`;
	}
	if (parsed.key.length === 1) {
		return `tell application "System Events" to keystroke ${appleScriptString(parsed.key.toLowerCase())}${modifierSuffix}`;
	}
	throw new Error(`Unsupported macOS key: ${parsed.key}`);
}

function macModifier(modifier: PlatformKey["modifiers"][number]): string {
	switch (modifier) {
		case "meta":
			return "command";
		case "alt":
			return "option";
		default:
			return modifier;
	}
}

const MAC_KEY_CODES: Record<string, number> = {
	ENTER: 36,
	TAB: 48,
	SPACE: 49,
	BACKSPACE: 51,
	ESC: 53,
	LEFT: 123,
	RIGHT: 124,
	DOWN: 125,
	UP: 126,
	DELETE: 117,
	HOME: 115,
	END: 119,
	PAGEUP: 116,
	PAGEDOWN: 121,
};

function appleScriptString(value: string): string {
	return JSON.stringify(value);
}
