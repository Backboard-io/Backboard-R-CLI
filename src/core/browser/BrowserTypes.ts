import type { ImageContentPayload } from "../image/ImageContent.ts";
import type { AccessibilityElement, ScreenSize } from "../platform/index.ts";
import type {
	BrowserAccessibilitySnapshot,
	BrowserFitPngInput,
	BrowserImagePayload,
	BrowserPlatformAction,
	BrowserScreenshotCapture,
} from "./BrowserPlatformBase.ts";

export type BrowserMouseButton = "left" | "right" | "middle";

export type BrowserKeyModifier = "meta" | "control" | "alt" | "shift";

export type BrowserTarget = { elementId: string } | { x: number; y: number };

export type BrowserAction =
	| { action: "screenshot" }
	| { action: "navigate"; url: string }
	| { action: "click"; target: BrowserTarget; button?: BrowserMouseButton }
	| { action: "type"; text: string }
	| {
			action: "key";
			key: string;
			modifiers?: BrowserKeyModifier[];
	  }
	| { action: "wait"; durationMs: number };

export interface BrowserObservation
	extends Partial<ImageContentPayload<"image/png">> {
	success: true;
	action: "screenshot";
	screenSize: ScreenSize;
	imageSize: ScreenSize;
	screenshotPath: string;
	screenshotScale: number;
	windowTitle?: string;
	elements: AccessibilityElement[];
	summary: string;
}

export interface BrowserActionResult {
	success: boolean;
	action: BrowserAction["action"];
	summary: string;
	error?: string;
}

export interface BrowserQueueResult {
	success: boolean;
	results: Array<BrowserObservation | BrowserActionResult>;
}

export interface BrowserPlatform {
	screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<BrowserScreenshotCapture>;
	accessibilitySnapshot(
		signal: AbortSignal,
	): Promise<BrowserAccessibilitySnapshot>;
	fitPngForPayload(input: BrowserFitPngInput): Promise<BrowserImagePayload>;
	execute(action: BrowserPlatformAction, signal: AbortSignal): Promise<void>;
	navigate(url: string, signal: AbortSignal): Promise<void>;
}
