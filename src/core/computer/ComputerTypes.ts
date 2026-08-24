import type { ImageContentPayload } from "../image/ImageContent.ts";
import type {
	AccessibilityElement,
	MouseButton,
	PlatformOs,
	ScreenBounds,
	ScreenSize,
} from "../platform/index.ts";

export type { MouseButton };

export type KeyModifier = "meta" | "control" | "alt" | "shift";

export type ComputerKey =
	| string
	| {
			key: string;
			modifiers?: Array<KeyModifier | string>;
	  };

/**
 * Where an action lands. `elementId` refers to an element of the latest
 * observation; `x`/`y` are in the latest observation's `screenSize` space.
 */
export type ComputerTarget = { elementId: string } | { x: number; y: number };

export type ScrollDirection = "up" | "down" | "left" | "right";

export type ComputerAction =
	| { action: "screenshot" }
	| { action: "zoom"; region: ScreenBounds }
	| {
			action: "click";
			target: ComputerTarget;
			button?: MouseButton;
			count?: number;
			modifiers?: KeyModifier[];
	  }
	| { action: "move"; target: ComputerTarget }
	| {
			action: "drag";
			from: ComputerTarget;
			to: ComputerTarget;
			button?: MouseButton;
	  }
	| {
			action: "scroll";
			target?: ComputerTarget;
			direction: ScrollDirection;
			amount?: number;
	  }
	| { action: "type"; text: string }
	| { action: "key"; key: ComputerKey; repeat?: number }
	| { action: "holdKey"; key: ComputerKey; durationMs: number }
	| { action: "wait"; durationMs: number }
	| { action: "openApp"; appName: string };

export type ComputerActionName = ComputerAction["action"];

/** Actions that never change machine state. */
export const READ_ONLY_COMPUTER_ACTIONS: ReadonlySet<ComputerActionName> =
	new Set<ComputerActionName>(["screenshot", "zoom", "wait", "move"]);

/** Actions after which element bounds from an older observation may be stale. */
export const STATE_CHANGING_COMPUTER_ACTIONS: ReadonlySet<ComputerActionName> =
	new Set<ComputerActionName>([
		"click",
		"drag",
		"scroll",
		"type",
		"key",
		"holdKey",
		"openApp",
	]);

export interface ComputerObservation
	extends Partial<ImageContentPayload<"image/png" | "image/jpeg">> {
	observationId: string;
	os: PlatformOs;
	/** Size of the screen in the coordinate space actions use. */
	screenSize: ScreenSize;
	/** Size of the attached image in pixels. */
	imageSize: ScreenSize;
	/** imageSize.width / screenSize.width. */
	scale: number;
	screenshotPath: string;
	/** Set on zoom observations: the part of the screen the image shows. */
	region?: ScreenBounds;
	appName?: string;
	processId?: number;
	windowTitle?: string;
	windowBounds?: ScreenBounds;
	focusedElementId?: string;
	/** True when a sheet or dialog is in front of the main window. */
	modal?: boolean;
	elements: AccessibilityElement[];
	/** False when accessibility permission is missing, so elements are empty. */
	accessibilityTrusted?: boolean;
	summary: string;
}

export interface ComputerActionResult {
	success: boolean;
	action: ComputerActionName;
	summary: string;
	durationMs: number;
	error?: string;
	/** True when an earlier action failed and this one was never attempted. */
	skipped?: boolean;
}

export interface ComputerQueueTiming {
	actionsMs: number;
	settleMs: number;
	observeMs: number;
	totalMs: number;
	settled?: boolean;
}

export interface ComputerQueueResult {
	success: boolean;
	os: PlatformOs;
	results: ComputerActionResult[];
	/** The screen after the queue ran. Carries the only image in the payload. */
	observation?: ComputerObservation;
	timing: ComputerQueueTiming;
	/** Index of the action that failed when the queue stopped early. */
	stoppedAt?: number;
}
