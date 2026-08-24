import { readFile } from "node:fs/promises";
import type { HelperProcess } from "./HelperProcess.ts";
import type {
	AccessibilityElement,
	AccessibilitySnapshot,
	Platform,
	PlatformAction,
	PlatformOs,
	ScreenBounds,
	ScreenshotCapture,
	ScreenshotOptions,
	SettleOptions,
	SettleResult,
} from "./types.ts";

export interface HelperCapture {
	path: string;
	imageSize: { width: number; height: number };
	screenSize: { width: number; height: number };
	scale: number;
	format: string;
	region?: ScreenBounds;
	display?: { displayId?: number };
	accessibility?: HelperAccessibility;
}

export interface HelperAccessibility {
	appName?: string;
	processId?: number;
	windowTitle?: string;
	windowBounds?: ScreenBounds;
	focusedElementId?: string;
	modal?: boolean;
	trusted?: boolean;
	elements?: AccessibilityElement[];
}

/**
 * Shared implementation for platforms that delegate to a persistent native
 * helper speaking the JSON-lines protocol (macOS Swift binary, Windows
 * PowerShell host). Subclasses only decide how the helper is started.
 */
export abstract class HelperPlatform implements Platform {
	abstract readonly os: PlatformOs;
	private helper: HelperProcess | null = null;
	private helperReady: Promise<HelperProcess> | null = null;

	protected abstract createHelper(signal: AbortSignal): Promise<HelperProcess>;

	async screenshot(
		options: ScreenshotOptions,
		signal: AbortSignal,
	): Promise<ScreenshotCapture> {
		const helper = await this.getHelper(signal);
		const result = await helper.request<HelperCapture>(
			captureRequest("capture", options),
			{ signal },
		);
		return toCapture(result, await readFile(result.path));
	}

	async accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		const helper = await this.getHelper(signal);
		const result = await helper.request<HelperAccessibility>(
			{ op: "ax" },
			{ signal },
		);
		return toSnapshot(result);
	}

	/**
	 * One helper round-trip for screenshot + accessibility tree, so an
	 * observation costs a single IPC instead of two.
	 */
	async observe(
		options: ScreenshotOptions,
		signal: AbortSignal,
	): Promise<{
		capture: ScreenshotCapture;
		accessibility: AccessibilitySnapshot;
	}> {
		const helper = await this.getHelper(signal);
		const result = await helper.request<HelperCapture>(
			captureRequest("observe", options),
			{ signal },
		);
		return {
			capture: toCapture(result, await readFile(result.path)),
			accessibility: toSnapshot(result.accessibility ?? { elements: [] }),
		};
	}

	async settle(
		options: SettleOptions,
		signal: AbortSignal,
	): Promise<SettleResult> {
		const helper = await this.getHelper(signal);
		const result = await helper.request<{
			settled: boolean;
			elapsedMs: number;
		}>(
			{
				op: "settle",
				timeoutMs: options.timeoutMs,
				intervalMs: options.intervalMs ?? 100,
				initialDelayMs: options.initialDelayMs ?? 60,
			},
			{ signal, timeoutMs: options.timeoutMs + 5000 },
		);
		return { settled: result.settled, elapsedMs: result.elapsedMs };
	}

	async execute(action: PlatformAction, signal: AbortSignal): Promise<void> {
		const helper = await this.getHelper(signal);
		await helper.request(helperRequest(action), { signal });
	}

	async dispose(): Promise<void> {
		const helper = this.helper;
		this.helper = null;
		this.helperReady = null;
		await helper?.dispose();
	}

	private getHelper(signal: AbortSignal): Promise<HelperProcess> {
		if (this.helper) return Promise.resolve(this.helper);
		if (!this.helperReady) {
			this.helperReady = this.createHelper(signal)
				.then((helper) => {
					this.helper = helper;
					return helper;
				})
				.catch((err) => {
					this.helperReady = null;
					throw err;
				});
		}
		return this.helperReady;
	}
}

function captureRequest(
	op: "capture" | "observe",
	options: ScreenshotOptions,
): Record<string, unknown> {
	return {
		op,
		path: options.path,
		maxWidth: options.maxWidth,
		format: options.format,
		quality: options.quality ?? 0.85,
		...(options.region ? { region: options.region } : {}),
	};
}

/** Maps a platform action onto the helper's JSON request shape. */
export function helperRequest(action: PlatformAction): Record<string, unknown> {
	switch (action.kind) {
		case "openApp":
			return { op: "openApp", appName: action.appName };
		case "type":
			return { op: "type", text: action.text };
		case "key":
			return {
				op: "key",
				key: action.key.key,
				modifiers: action.key.modifiers,
				repeat: action.repeat ?? 1,
			};
		case "holdKey":
			return {
				op: "key",
				key: action.key.key,
				modifiers: action.key.modifiers,
				holdMs: action.durationMs,
			};
		case "click":
			return {
				op: "click",
				x: action.point.x,
				y: action.point.y,
				button: action.button,
				count: action.count,
				modifiers: action.modifiers,
			};
		case "move":
			return { op: "move", x: action.point.x, y: action.point.y };
		case "drag":
			return {
				op: "drag",
				fromX: action.from.x,
				fromY: action.from.y,
				toX: action.to.x,
				toY: action.to.y,
				button: action.button,
			};
		case "scroll":
			return {
				op: "scroll",
				dx: action.dx,
				dy: action.dy,
				...(action.point ? { x: action.point.x, y: action.point.y } : {}),
			};
	}
}

function toCapture(result: HelperCapture, bytes: Buffer): ScreenshotCapture {
	return {
		path: result.path,
		bytes,
		mediaType: result.format === "jpeg" ? "image/jpeg" : "image/png",
		imageSize: result.imageSize,
		screenSize: result.screenSize,
		scale: result.scale,
		...(result.region ? { region: result.region } : {}),
		...(result.display?.displayId !== undefined
			? { displayId: result.display.displayId }
			: {}),
	};
}

function toSnapshot(result: HelperAccessibility): AccessibilitySnapshot {
	return {
		...(result.appName ? { appName: result.appName } : {}),
		...(typeof result.processId === "number"
			? { processId: result.processId }
			: {}),
		...(result.windowTitle ? { windowTitle: result.windowTitle } : {}),
		...(result.windowBounds ? { windowBounds: result.windowBounds } : {}),
		...(result.focusedElementId
			? { focusedElementId: result.focusedElementId }
			: {}),
		...(result.modal ? { modal: true } : {}),
		...(typeof result.trusted === "boolean" ? { trusted: result.trusted } : {}),
		elements: Array.isArray(result.elements) ? result.elements : [],
	};
}
