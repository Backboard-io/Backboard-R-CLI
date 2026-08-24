import { HelperPlatform } from "./HelperPlatform.ts";
import { HelperProcess } from "./HelperProcess.ts";
import { ensureMacHelperBinary } from "./mac/MacHelperBinary.ts";

export interface MacPlatformOptions {
	/** Skip compilation and use this helper binary (tests, custom builds). */
	helperPath?: string;
	onCompileStart?: () => void;
}

/**
 * macOS platform backed by a persistent, compiled Swift helper
 * (`mac/cuaHelper.swift`). Screen capture goes through ScreenCaptureKit, input
 * through CGEvent, and the accessibility tree through AXUIElement — all in one
 * process that stays warm between actions.
 */
export class MacPlatform extends HelperPlatform {
	readonly os = "darwin" as const;

	constructor(private readonly options: MacPlatformOptions = {}) {
		super();
	}

	protected async createHelper(signal: AbortSignal): Promise<HelperProcess> {
		const command =
			this.options.helperPath ??
			(await ensureMacHelperBinary({
				signal,
				onCompileStart: this.options.onCompileStart,
			}));
		return new HelperProcess({
			command,
			label: "computer-use helper",
			requestTimeoutMs: 20_000,
		});
	}
}
