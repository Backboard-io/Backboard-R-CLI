import type {
	AccessibilitySnapshot,
	FitPngForPayloadInput,
	ImagePayload,
	Platform,
	PlatformAction,
	ResizePngInput,
	ScreenshotCapture,
} from "./types.ts";

export abstract class BasePlatform implements Platform {
	abstract screenshot(
		path: string,
		signal: AbortSignal,
	): Promise<ScreenshotCapture>;

	abstract execute(action: PlatformAction, signal: AbortSignal): Promise<void>;

	async accessibilitySnapshot(
		_signal: AbortSignal,
	): Promise<AccessibilitySnapshot> {
		return { elements: [] };
	}

	async fitPngForPayload(input: FitPngForPayloadInput): Promise<ImagePayload> {
		if (input.bytes.byteLength <= input.maxBytes) {
			return {
				bytes: input.bytes,
				imageSize: input.screenSize,
				scale: 1,
				compressed: false,
			};
		}

		const resized = await this.resizePng(input);
		if (resized) return resized;

		throw new Error(
			`Screenshot could not be compressed below ${input.maxBytes} bytes on ${process.platform}`,
		);
	}

	protected async resizePng(
		_input: ResizePngInput,
	): Promise<ImagePayload | null> {
		return null;
	}
}
