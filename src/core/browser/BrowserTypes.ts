import type { ImageContentPayload } from "../image/ImageContent.ts";
import type {
	AccessibilityElement,
	ImagePayload,
	Platform,
	ScreenshotCapture,
} from "../platform/index.ts";

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
	screenSize: ScreenshotCapture["screenSize"];
	imageSize: ImagePayload["imageSize"];
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

export interface BrowserPlatform extends Platform {
	navigate(url: string, signal: AbortSignal): Promise<void>;
}
