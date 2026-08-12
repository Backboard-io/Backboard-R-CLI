import type { ImageContentPayload } from "../image/ImageContent.ts";
import type { AccessibilityElement, ScreenSize } from "../platform/index.ts";

export type MouseButton = "left" | "right" | "middle";

export type KeyModifier = "meta" | "control" | "alt" | "shift";

export type KeyName =
	| "ENTER"
	| "TAB"
	| "SPACE"
	| "ESC"
	| "BACKSPACE"
	| "DELETE"
	| "UP"
	| "DOWN"
	| "LEFT"
	| "RIGHT"
	| "HOME"
	| "END"
	| "PAGEUP"
	| "PAGEDOWN"
	| (string & {});

export type ComputerKey =
	| string
	| {
			key: KeyName;
			modifiers?: Array<KeyModifier | string>;
	  };

export type ComputerTarget = { elementId: string } | { x: number; y: number };

export type ComputerAction =
	| { action: "screenshot" }
	| { action: "click"; target: ComputerTarget; button?: MouseButton }
	| { action: "type"; text: string }
	| { action: "key"; key: ComputerKey }
	| { action: "wait"; durationMs: number }
	| { action: "openApp"; appName: string };

export interface ComputerObservation extends ImageContentPayload<"image/png"> {
	success: true;
	action: "screenshot";
	observationId: string;
	screenSize: ScreenSize;
	imageSize: ScreenSize;
	screenshotPath: string;
	screenshotScale: number;
	appName?: string;
	processId?: number;
	windowTitle?: string;
	elements: AccessibilityElement[];
	summary: string;
}

export interface ComputerActionResult {
	success: boolean;
	action: ComputerAction["action"];
	observationId?: string;
	verification: "passed" | "failed" | "unknown";
	summary: string;
	error?: string;
	observation?: ComputerObservation;
}

export interface ComputerQueueResult {
	success: boolean;
	results: Array<ComputerObservation | ComputerActionResult>;
}
