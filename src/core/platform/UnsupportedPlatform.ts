import type {
	AccessibilitySnapshot,
	Platform,
	PlatformAction,
	PlatformOs,
	ScreenshotCapture,
	SettleResult,
} from "./types.ts";

export class UnsupportedPlatform implements Platform {
	readonly os: PlatformOs;

	constructor(private readonly platform: string) {
		this.os = "linux";
	}

	async screenshot(): Promise<ScreenshotCapture> {
		throw new Error(
			`Computer screenshots are not supported on ${this.platform}`,
		);
	}

	async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
		return { elements: [] };
	}

	async settle(): Promise<SettleResult> {
		return { settled: false, elapsedMs: 0 };
	}

	async execute(action: PlatformAction): Promise<void> {
		throw new Error(
			`Computer action "${action.kind}" is not supported on ${this.platform}`,
		);
	}

	async dispose(): Promise<void> {}
}
