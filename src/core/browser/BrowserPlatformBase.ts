import type {
	AccessibilityElement,
	PlatformKey,
	ScreenSize,
} from "../platform/types.ts";

/** Browser-side accessibility snapshot: the DOM tree of the active tab. */
export interface BrowserAccessibilityElement extends AccessibilityElement {
	appName?: string;
	processId?: number;
	windowTitle?: string;
}

export interface BrowserAccessibilitySnapshot {
	appName?: string;
	processId?: number;
	windowTitle?: string;
	elements: BrowserAccessibilityElement[];
}

export type BrowserPlatformAction =
	| { kind: "openApp"; appName: string }
	| { kind: "type"; text: string }
	| { kind: "key"; key: PlatformKey }
	| {
			kind: "click";
			point: { x: number; y: number };
			button: "left" | "right" | "middle";
	  };

export interface BrowserScreenshotCapture {
	path: string;
	bytes: Buffer;
	screenSize: ScreenSize;
}

export interface BrowserImagePayload {
	bytes: Buffer;
	imageSize: ScreenSize;
	scale: number;
	compressed: boolean;
}

export interface BrowserFitPngInput {
	path: string;
	bytes: Buffer;
	screenSize: ScreenSize;
	maxBytes: number;
	signal: AbortSignal;
}

/**
 * Minimal driver contract for the browser tool. The browser renders at CSS
 * resolution and never needs native resizing, so payload fitting is a size
 * check rather than a re-encode.
 */
export abstract class BrowserPlatformBase {
	abstract screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<BrowserScreenshotCapture>;

	abstract execute(
		action: BrowserPlatformAction,
		signal: AbortSignal,
	): Promise<void>;

	async accessibilitySnapshot(
		_signal: AbortSignal,
	): Promise<BrowserAccessibilitySnapshot> {
		return { elements: [] };
	}

	async fitPngForPayload(
		input: BrowserFitPngInput,
	): Promise<BrowserImagePayload> {
		if (input.bytes.byteLength <= input.maxBytes) {
			return {
				bytes: input.bytes,
				imageSize: input.screenSize,
				scale: 1,
				compressed: false,
			};
		}
		throw new Error(
			`Browser screenshot could not be compressed below ${input.maxBytes} bytes`,
		);
	}
}
