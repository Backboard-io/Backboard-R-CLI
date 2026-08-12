import { errorMessage } from "../../utils/errors.ts";
import { ComputerPaths } from "../computer/ComputerPaths.ts";
import { ImageContent } from "../image/ImageContent.ts";
import type { PlatformKey } from "../platform/index.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { BrowserSessionManager } from "./BrowserSessionManager.ts";
import type {
	BrowserAction,
	BrowserActionResult,
	BrowserObservation,
	BrowserPlatform,
	BrowserQueueResult,
	BrowserTarget,
} from "./BrowserTypes.ts";

const MAX_IMAGE_BYTES = 1_500_000;

export interface BrowserRuntimeOptions {
	platform?: BrowserPlatform;
	sessionManager?: BrowserSessionManager;
}

export class BrowserRuntime {
	private platform: BrowserPlatform | null;
	private readonly sessionManager: BrowserSessionManager;
	private lastObservation: BrowserObservation | null = null;

	constructor(options: BrowserRuntimeOptions = {}) {
		this.platform = options.platform ?? null;
		this.sessionManager = options.sessionManager ?? new BrowserSessionManager();
	}

	async prepare(signal?: AbortSignal): Promise<void> {
		await this.getPlatform(signal);
	}

	async dispose(): Promise<void> {
		await this.sessionManager?.dispose();
	}

	async execute(
		actions: BrowserAction[],
		ctx: ToolContext,
		options: { defaultDelayMs?: number; stopOnError?: boolean } = {},
	): Promise<BrowserQueueResult> {
		const results: BrowserQueueResult["results"] = [];
		for (const action of actions) {
			if (ctx.signal.aborted) throw new Error("aborted");
			if (results.length > 0 && options.defaultDelayMs) {
				await delay(options.defaultDelayMs, ctx.signal);
			}
			const result = await this.executeOne(action, ctx);
			results.push(result);
			if (!result.success && options.stopOnError !== false) break;
		}
		return {
			success: results.every((result) => result.success),
			results,
		};
	}

	private async executeOne(
		action: BrowserAction,
		ctx: ToolContext,
	): Promise<BrowserObservation | BrowserActionResult> {
		try {
			const platform = await this.getPlatform(ctx.signal);
			switch (action.action) {
				case "screenshot":
					return await this.capture(ctx);
				case "wait":
					await delay(action.durationMs, ctx.signal);
					return {
						success: true,
						action: action.action,
						summary: `Waited ${action.durationMs}ms.`,
					};
				case "navigate":
					await platform.navigate(action.url, ctx.signal);
					return await this.capture(ctx);
				case "type":
					await platform.execute(
						{ kind: "type", text: action.text },
						ctx.signal,
					);
					return {
						success: true,
						action: action.action,
						summary: "Typed text.",
					};
				case "key":
					await platform.execute(
						{ kind: "key", key: normalizeKey(action.key, action.modifiers) },
						ctx.signal,
					);
					return {
						success: true,
						action: action.action,
						summary: "Pressed key.",
					};
				case "click":
					await platform.execute(
						{
							kind: "click",
							point: this.resolveTarget(action.target),
							button: action.button ?? "left",
						},
						ctx.signal,
					);
					return await this.capture(ctx);
				default:
					return assertNever(action);
			}
		} catch (err) {
			return {
				success: false,
				action: action.action,
				summary: `Failed to execute ${action.action}.`,
				error: errorMessage(err),
			};
		}
	}

	private async capture(ctx: ToolContext): Promise<BrowserObservation> {
		const platform = await this.getPlatform(ctx.signal);
		const path = await new ComputerPaths(ctx.sessionId).nextScreenshotPath();
		const screenshot = await platform.screenshot(path, ctx.signal);
		const image = await platform.fitPngForPayload({
			path,
			bytes: screenshot.bytes,
			screenSize: screenshot.screenSize,
			maxBytes: MAX_IMAGE_BYTES,
			signal: ctx.signal,
		});
		const snapshot = await platform.accessibilitySnapshot(ctx.signal);
		const observation: BrowserObservation = {
			success: true,
			action: "screenshot",
			screenSize: screenshot.screenSize,
			imageSize: image.imageSize,
			screenshotPath: path,
			screenshotScale: image.scale,
			windowTitle: snapshot.windowTitle,
			elements: snapshot.elements,
			summary: image.compressed
				? "Captured compressed browser screenshot."
				: "Captured browser screenshot.",
			...ImageContent.fromBytes(image.bytes, "image/png"),
		};
		this.lastObservation = observation;
		return observation;
	}

	private async getPlatform(signal?: AbortSignal): Promise<BrowserPlatform> {
		if (this.platform) return this.platform;
		this.platform = await this.sessionManager.getPlatform(signal);
		return this.platform;
	}

	private resolveTarget(target: BrowserTarget): { x: number; y: number } {
		if ("x" in target) return target;
		const element = this.lastObservation?.elements.find(
			(item) => item.id === target.elementId,
		);
		if (!element?.bounds) {
			throw new Error(
				"A fresh browser screenshot is required before clicking elementId targets.",
			);
		}
		return {
			x: element.bounds.x + element.bounds.width / 2,
			y: element.bounds.y + element.bounds.height / 2,
		};
	}
}

function normalizeKey(
	key: string,
	modifiers?: PlatformKey["modifiers"],
): PlatformKey {
	return {
		key: key.toUpperCase(),
		modifiers: modifiers ?? [],
	};
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

function assertNever(value: never): never {
	throw new Error(`Unsupported browser action: ${JSON.stringify(value)}`);
}
