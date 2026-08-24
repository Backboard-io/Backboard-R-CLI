import { ImageContent } from "../image/ImageContent.ts";
import type {
	AccessibilitySnapshot,
	Platform,
	ScreenBounds,
	ScreenshotCapture,
	ScreenshotOptions,
} from "../platform/index.ts";
import { HelperPlatform } from "../platform/index.ts";
import { ComputerPaths } from "./ComputerPaths.ts";
import type { ComputerObservation } from "./ComputerTypes.ts";

/** Longest image edge sent to the model; matches provider guidance (~WXGA). */
export const DEFAULT_MAX_IMAGE_WIDTH = 1280;
/** Hard ceiling on encoded bytes; a larger frame is re-encoded smaller. */
export const MAX_IMAGE_BYTES = 1_200_000;
const FALLBACK_WIDTHS = [1024, 800, 640];

export interface ObserveOptions {
	region?: ScreenBounds;
	maxWidth?: number;
	format?: "png" | "jpeg";
	quality?: number;
}

let observationCounter = 0;

/**
 * Produces one {@link ComputerObservation}: a downscaled screenshot plus the
 * accessibility elements of the frontmost window, both in the platform's
 * point space. Uses the helper's combined `observe` op when available.
 */
export class ComputerObserver {
	private captures = 0;

	constructor(
		sessionId: string,
		private readonly platform: Platform,
		private readonly paths = new ComputerPaths(sessionId),
	) {}

	async observe(
		signal: AbortSignal,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		const format = options.format ?? "jpeg";
		const path = await this.paths.nextScreenshotPath(
			format === "jpeg" ? "jpg" : "png",
		);
		const base: ScreenshotOptions = {
			path,
			maxWidth: options.maxWidth ?? DEFAULT_MAX_IMAGE_WIDTH,
			format,
			quality: options.quality ?? 0.85,
			...(options.region ? { region: options.region } : {}),
		};
		let { capture, accessibility } = await this.captureBoth(base, signal);
		for (const width of FALLBACK_WIDTHS) {
			if (capture.bytes.byteLength <= MAX_IMAGE_BYTES) break;
			if (width >= base.maxWidth) continue;
			capture = await this.platform.screenshot(
				{ ...base, maxWidth: width },
				signal,
			);
		}
		this.captures++;
		if (this.captures % 10 === 0) void this.paths.pruneSession();
		if (this.captures === 1) void this.paths.pruneOldSessions();
		observationCounter++;
		return {
			observationId: `obs_${Date.now().toString(36)}_${observationCounter}`,
			os: this.platform.os,
			screenSize: capture.screenSize,
			imageSize: capture.imageSize,
			scale: capture.scale,
			screenshotPath: capture.path,
			...(capture.region ? { region: capture.region } : {}),
			...(accessibility.appName ? { appName: accessibility.appName } : {}),
			...(accessibility.processId !== undefined
				? { processId: accessibility.processId }
				: {}),
			...(accessibility.windowTitle
				? { windowTitle: accessibility.windowTitle }
				: {}),
			...(accessibility.windowBounds
				? { windowBounds: accessibility.windowBounds }
				: {}),
			...(accessibility.focusedElementId
				? { focusedElementId: accessibility.focusedElementId }
				: {}),
			...(accessibility.modal ? { modal: true } : {}),
			elements: options.region ? [] : accessibility.elements,
			...(accessibility.trusted === false
				? { accessibilityTrusted: false }
				: {}),
			summary: options.region
				? `Zoomed into ${Math.round(options.region.width)}x${Math.round(options.region.height)} region at (${Math.round(options.region.x)}, ${Math.round(options.region.y)}).`
				: `Captured ${capture.imageSize.width}x${capture.imageSize.height} screenshot with ${accessibility.elements.length} elements.`,
			...ImageContent.fromBytes(capture.bytes, capture.mediaType),
		};
	}

	/** Accessibility tree only — cheap, used to re-resolve element targets. */
	accessibility(signal: AbortSignal): Promise<AccessibilitySnapshot> {
		return this.platform.accessibilitySnapshot(signal);
	}

	private async captureBoth(
		options: ScreenshotOptions,
		signal: AbortSignal,
	): Promise<{
		capture: ScreenshotCapture;
		accessibility: AccessibilitySnapshot;
	}> {
		if (this.platform instanceof HelperPlatform) {
			return this.platform.observe(options, signal);
		}
		const capture = await this.platform.screenshot(options, signal);
		const accessibility = await this.platform.accessibilitySnapshot(signal);
		return { capture, accessibility };
	}
}
