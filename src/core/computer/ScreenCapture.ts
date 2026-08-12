import { ImageContent } from "../image/ImageContent.ts";
import type { Platform } from "../platform/index.ts";
import { ComputerPaths } from "./ComputerPaths.ts";
import type { ComputerObservation } from "./ComputerTypes.ts";

const MAX_IMAGE_BYTES = 1_500_000;

export class ScreenCapture {
	constructor(
		private readonly sessionId: string,
		private readonly platform: Platform,
	) {}

	async capture(signal: AbortSignal): Promise<ComputerObservation> {
		const path = await new ComputerPaths(this.sessionId).nextScreenshotPath();
		const shot = await this.platform.screenshot(path, signal);
		const image = await this.platform.fitPngForPayload({
			path,
			bytes: shot.bytes,
			screenSize: shot.screenSize,
			maxBytes: MAX_IMAGE_BYTES,
			signal,
		});
		const accessibility = await this.platform.accessibilitySnapshot(signal);
		return {
			success: true,
			action: "screenshot",
			observationId: `obs_${Date.now().toString(36)}`,
			screenSize: shot.screenSize,
			imageSize: image.imageSize,
			screenshotPath: shot.path,
			screenshotScale: image.scale,
			appName: accessibility.appName,
			processId: accessibility.processId,
			windowTitle: accessibility.windowTitle,
			elements: accessibility.elements,
			summary: image.compressed
				? "Captured compressed screenshot."
				: "Captured screenshot.",
			...ImageContent.fromBytes(image.bytes, "image/png"),
		};
	}
}
