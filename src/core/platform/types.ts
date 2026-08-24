export type PlatformKeyModifier = "meta" | "control" | "alt" | "shift";

export interface PlatformKey {
	key: string;
	modifiers: PlatformKeyModifier[];
}

export interface ScreenSize {
	width: number;
	height: number;
}

export interface ScreenPoint {
	x: number;
	y: number;
}

export interface ScreenBounds extends ScreenPoint {
	width: number;
	height: number;
}

export type PlatformOs = "darwin" | "win32" | "linux";

export type MouseButton = "left" | "right" | "middle";

/**
 * One on-screen element from the platform accessibility tree. `bounds` are in
 * the platform's *point* space (the same space every `PlatformAction` point is
 * in), relative to the top-left of the captured display.
 */
export interface AccessibilityElement {
	id: string;
	role: string;
	name?: string;
	value?: string;
	bounds?: ScreenBounds;
	enabled?: boolean;
	focused?: boolean;
}

export interface AccessibilitySnapshot {
	appName?: string;
	processId?: number;
	windowTitle?: string;
	windowBounds?: ScreenBounds;
	focusedElementId?: string;
	/** True when a sheet or dialog is in front of the main window. */
	modal?: boolean;
	elements: AccessibilityElement[];
	/** False when the platform lacks the permission it needs to read the tree. */
	trusted?: boolean;
}

export type PlatformAction =
	| { kind: "openApp"; appName: string }
	| { kind: "type"; text: string }
	| { kind: "key"; key: PlatformKey; repeat?: number }
	| { kind: "holdKey"; key: PlatformKey; durationMs: number }
	| {
			kind: "click";
			point: ScreenPoint;
			button: MouseButton;
			count: number;
			modifiers: PlatformKeyModifier[];
	  }
	| { kind: "move"; point: ScreenPoint }
	| { kind: "drag"; from: ScreenPoint; to: ScreenPoint; button: MouseButton }
	| { kind: "scroll"; point?: ScreenPoint; dx: number; dy: number };

export interface ScreenshotOptions {
	/** Destination file path. */
	path: string;
	/** Longest allowed width for the returned image, in pixels. */
	maxWidth: number;
	format: "png" | "jpeg";
	/** 0-1, JPEG only. */
	quality?: number;
	/** Optional crop, in point space. */
	region?: ScreenBounds;
}

export interface ScreenshotCapture {
	path: string;
	bytes: Buffer;
	mediaType: "image/png" | "image/jpeg";
	/** Size of the encoded image in pixels. */
	imageSize: ScreenSize;
	/** Size of the display (or cropped region) in point space. */
	screenSize: ScreenSize;
	/** imageSize.width / screenSize.width — maps image pixels to points. */
	scale: number;
	/** The crop that was applied, in point space, when `region` was requested. */
	region?: ScreenBounds;
	displayId?: number;
}

export interface SettleOptions {
	timeoutMs: number;
	intervalMs?: number;
	initialDelayMs?: number;
}

export interface SettleResult {
	settled: boolean;
	elapsedMs: number;
}

export interface Platform {
	readonly os: PlatformOs;
	screenshot(
		options: ScreenshotOptions,
		signal: AbortSignal,
	): Promise<ScreenshotCapture>;
	accessibilitySnapshot(signal: AbortSignal): Promise<AccessibilitySnapshot>;
	/**
	 * Waits until the screen stops changing (or the timeout elapses). Platforms
	 * without cheap capture may resolve immediately with `settled: false`.
	 */
	settle(options: SettleOptions, signal: AbortSignal): Promise<SettleResult>;
	execute(action: PlatformAction, signal: AbortSignal): Promise<void>;
	dispose(): Promise<void>;
}
