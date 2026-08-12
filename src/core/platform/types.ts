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

export interface AccessibilityElement {
	id: string;
	appName?: string;
	processId?: number;
	windowTitle?: string;
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
	elements: AccessibilityElement[];
}

export type PlatformAction =
	| { kind: "openApp"; appName: string }
	| { kind: "type"; text: string }
	| { kind: "key"; key: PlatformKey }
	| { kind: "click"; point: ScreenPoint; button: "left" | "right" | "middle" };

export interface ScreenshotCapture {
	path: string;
	bytes: Buffer;
	screenSize: ScreenSize;
}

export interface ImagePayload {
	bytes: Buffer;
	imageSize: ScreenSize;
	scale: number;
	compressed: boolean;
}

export interface FitPngForPayloadInput {
	path: string;
	bytes: Buffer;
	screenSize: ScreenSize;
	maxBytes: number;
	signal: AbortSignal;
}

export interface ResizePngInput {
	path: string;
	screenSize: ScreenSize;
	maxBytes: number;
	signal: AbortSignal;
}

export interface Platform {
	screenshot(path: string, signal: AbortSignal): Promise<ScreenshotCapture>;
	accessibilitySnapshot(signal: AbortSignal): Promise<AccessibilitySnapshot>;
	fitPngForPayload(input: FitPngForPayloadInput): Promise<ImagePayload>;
	execute(action: PlatformAction, signal: AbortSignal): Promise<void>;
}
