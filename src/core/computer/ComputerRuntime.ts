import { errorMessage } from "../../utils/errors.ts";
import { createPlatform, type Platform } from "../platform/index.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { toPlatformAction } from "./ComputerPlatformAction.ts";
import type {
	ComputerAction,
	ComputerActionResult,
	ComputerObservation,
	ComputerQueueResult,
} from "./ComputerTypes.ts";
import { ScreenCapture } from "./ScreenCapture.ts";

export interface ComputerRuntimeOptions {
	platform?: Platform;
}

export class ComputerRuntime {
	private readonly platform: Platform;
	private lastObservation: ComputerObservation | null = null;

	constructor(options: ComputerRuntimeOptions = {}) {
		this.platform = options.platform ?? createPlatform();
	}

	async execute(
		actions: ComputerAction[],
		ctx: ToolContext,
		options: { defaultDelayMs?: number; stopOnError?: boolean } = {},
	): Promise<ComputerQueueResult> {
		const results: ComputerQueueResult["results"] = [];
		for (const action of actions) {
			if (ctx.signal.aborted) throw new Error("aborted");
			if (results.length > 0 && options.defaultDelayMs) {
				await delay(options.defaultDelayMs, ctx.signal);
			}
			const result = await this.executeOne(action, ctx);
			results.push(result);
			if (!result.success && options.stopOnError !== false) break;
		}
		if (
			actions.length > 1 &&
			results.every((r) => r.success) &&
			actions[actions.length - 1]?.action !== "screenshot"
		) {
			const observation = await new ScreenCapture(
				ctx.sessionId,
				this.platform,
			).capture(ctx.signal);
			this.lastObservation = observation;
			results.push(observation);
		}
		return {
			success: results.every((r) => r.success),
			results,
		};
	}

	private async executeOne(
		action: ComputerAction,
		ctx: ToolContext,
	): Promise<ComputerObservation | ComputerActionResult> {
		if (action.action === "screenshot") {
			const observation = await new ScreenCapture(
				ctx.sessionId,
				this.platform,
			).capture(ctx.signal);
			this.lastObservation = observation;
			return observation;
		}
		if (action.action === "wait") {
			await delay(action.durationMs, ctx.signal);
			return {
				success: true,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "unknown",
				summary: `Waited ${action.durationMs}ms.`,
			};
		}

		const validation = this.validateAction(action);
		if (validation) return validation;

		try {
			await this.platform.execute(
				toPlatformAction(action, this.lastObservation),
				ctx.signal,
			);
			const result: ComputerActionResult = {
				success: true,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "unknown",
				summary: `Executed ${action.action}.`,
			};
			const observation = await this.capturePostActionObservation(action, ctx);
			if (!observation) return result;
			return {
				...result,
				observationId: observation.observationId,
				verification: "passed",
				summary: `${result.summary} Captured updated screenshot.`,
				observation,
			};
		} catch (err) {
			return {
				success: false,
				action: action.action,
				observationId: this.lastObservation?.observationId,
				verification: "failed",
				summary: `Failed to execute ${action.action}.`,
				error: errorMessage(err),
			};
		}
	}

	private validateAction(action: ComputerAction): ComputerActionResult | null {
		if (!requiresObservation(action)) return null;
		if (!this.lastObservation) {
			return {
				success: false,
				action: action.action,
				verification: "failed",
				summary: "A fresh screenshot is required before this action.",
				error:
					'Call Computer with {"actions":[{"action":"screenshot"}]} before acting on the screen.',
			};
		}
		return null;
	}

	private async capturePostActionObservation(
		action: ComputerAction,
		ctx: ToolContext,
	): Promise<ComputerObservation | null> {
		if (action.action === "type" || action.action === "key") return null;
		await delay(action.action === "openApp" ? 1200 : 300, ctx.signal);
		const observation = await new ScreenCapture(
			ctx.sessionId,
			this.platform,
		).capture(ctx.signal);
		this.lastObservation = observation;
		return observation;
	}
}

function requiresObservation(action: ComputerAction): boolean {
	switch (action.action) {
		case "click":
			return true;
		default:
			return false;
	}
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
