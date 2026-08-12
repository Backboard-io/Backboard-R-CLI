import { MacPlatform } from "./MacPlatform.ts";
import type { Platform } from "./types.ts";
import { UnsupportedPlatform } from "./UnsupportedPlatform.ts";
import { WindowsPlatform } from "./WindowsPlatform.ts";

export function createPlatform(): Platform {
	switch (process.platform) {
		case "darwin":
			return new MacPlatform();
		case "win32":
			return new WindowsPlatform();
		default:
			return new UnsupportedPlatform(process.platform);
	}
}
