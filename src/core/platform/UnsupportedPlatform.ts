import { BasePlatform } from "./BasePlatform.ts";
import type { PlatformAction, ScreenshotCapture } from "./types.ts";

export class UnsupportedPlatform extends BasePlatform {
	constructor(private readonly platform: string) {
		super();
	}

	async screenshot(): Promise<ScreenshotCapture> {
		throw new Error(
			`Computer screenshots are not supported on ${this.platform}`,
		);
	}

	async execute(action: PlatformAction): Promise<void> {
		throw new Error(
			`Computer action "${action.kind}" is not supported on ${this.platform}`,
		);
	}
}
