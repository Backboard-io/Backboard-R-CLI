import { errorMessage } from "../../utils/errors.ts";
import {
	type AccessibilityElement,
	createPlatform,
	type Platform,
} from "../platform/index.ts";
import type { ToolContext } from "../tools/ToolContext.ts";
import { formatComputerKey, normalizeComputerKey } from "./ComputerKeys.ts";
import { ComputerObserver } from "./ComputerObserver.ts";
import {
	ObservationTargetResolver,
	refreshElementBounds,
	toPlatformAction,
} from "./ComputerPlatformAction.ts";
import {
	type ComputerAction,
	type ComputerActionResult,
	type ComputerObservation,
	type ComputerQueueResult,
	type ComputerTarget,
	STATE_CHANGING_COMPUTER_ACTIONS,
} from "./ComputerTypes.ts";

export interface ComputerRuntimeOptions {
	platform?: Platform;
	/** Milliseconds to wait for the screen to settle after a batch. */
	settleTimeoutMs?: number;
	/** Longer settle window after launching an application. */
	openAppSettleTimeoutMs?: number;
}

export interface ComputerExecuteOptions {
	defaultDelayMs?: number;
	stopOnError?: boolean;
}

interface ComputerSessionState {
	lastObservation: ComputerObservation | null;
	liveElements: AccessibilityElement[] | null;
	elementsDirty: boolean;
}

const SKIPPED_SUMMARY = "Not executed: an earlier action in this batch failed.";
const MAX_SESSION_STATES = 4;

/**
 * Runs a batch of computer actions with the semantics every major provider
 * converged on: execute sequentially, stop at the first failure (marking the
 * rest as skipped), wait for the screen to settle, and return exactly one
 * observation — the final screen — carrying the only image in the payload.
 */
export class ComputerRuntime {
	private platformInstance: Platform | null;
	private observers = new Map<string, ComputerObserver>();
	private sessionStates = new Map<string, ComputerSessionState>();
	private lastObservation: ComputerObservation | null = null;
	private readonly settleTimeoutMs: number;
	private readonly openAppSettleTimeoutMs: number;

	constructor(private readonly options: ComputerRuntimeOptions = {}) {
		this.platformInstance = options.platform ?? null;
		this.settleTimeoutMs = options.settleTimeoutMs ?? 1200;
		this.openAppSettleTimeoutMs = options.openAppSettleTimeoutMs ?? 3000;
	}

	get platform(): Platform {
		if (!this.platformInstance) this.platformInstance = createPlatform();
		return this.platformInstance;
	}

	get latestObservation(): ComputerObservation | null {
		return this.lastObservation;
	}

	async execute(
		actions: ComputerAction[],
		ctx: ToolContext,
		options: ComputerExecuteOptions = {},
	): Promise<ComputerQueueResult> {
		const startedAt = performance.now();
		const observer = this.observerFor(ctx.sessionId);
		const state = this.stateFor(ctx.sessionId);
		const results: ComputerActionResult[] = [];
		let stoppedAt: number | undefined;
		let stateChanged = false;
		let launchedApp = false;
		let finalObservation: ComputerObservation | null = null;
		let actionsMs = 0;
		let settleMs = 0;
		let settled: boolean | undefined;

		const settleScreen = async (): Promise<void> => {
			if (!stateChanged) return;
			const settleStart = performance.now();
			try {
				const outcome = await this.platform.settle(
					{
						timeoutMs: launchedApp
							? this.openAppSettleTimeoutMs
							: this.settleTimeoutMs,
						initialDelayMs: launchedApp ? 750 : 80,
					},
					ctx.signal,
				);
				settled = outcome.settled;
			} catch (err) {
				if (ctx.signal.aborted) throw err;
				settled = false;
			}
			settleMs += Math.round(performance.now() - settleStart);
			stateChanged = false;
			launchedApp = false;
		};

		for (const [index, action] of actions.entries()) {
			if (ctx.signal.aborted) throw new Error("aborted");
			if (stoppedAt !== undefined) {
				results.push({
					success: false,
					action: action.action,
					summary: SKIPPED_SUMMARY,
					durationMs: 0,
					skipped: true,
				});
				continue;
			}
			if (index > 0 && options.defaultDelayMs) {
				await delay(options.defaultDelayMs, ctx.signal);
			}
			if (
				stateChanged &&
				(action.action === "screenshot" ||
					action.action === "zoom" ||
					launchedApp)
			) {
				await settleScreen();
			}
			const started = performance.now();
			const outcome = await this.executeOne(action, ctx, observer, state);
			const durationMs = Math.round(performance.now() - started);
			actionsMs += durationMs;
			results.push({ ...outcome.result, durationMs });
			if (outcome.observation) {
				finalObservation = outcome.observation;
				stateChanged = false;
			} else {
				// Every action after an observation may affect what the user sees:
				// waits allow async UI updates, moves can reveal hover UI, and even
				// failed actions need a fresh screen for recovery.
				finalObservation = null;
			}
			if (outcome.result.success) {
				if (STATE_CHANGING_COMPUTER_ACTIONS.has(action.action)) {
					stateChanged = true;
					finalObservation = null;
					state.elementsDirty = true;
				}
				if (action.action === "openApp") launchedApp = true;
			} else if (options.stopOnError !== false) {
				stoppedAt = index;
			}
		}

		let observeMs = 0;
		if (!finalObservation && actions.length > 0) {
			await settleScreen();
			const observeStart = performance.now();
			try {
				finalObservation = await observer.observe(ctx.signal);
				this.remember(state, finalObservation);
			} catch (err) {
				if (ctx.signal.aborted) throw err;
				results.push({
					success: false,
					action: "screenshot",
					summary: "Could not capture the screen after the batch.",
					durationMs: Math.round(performance.now() - observeStart),
					error: errorMessage(err),
				});
			}
			observeMs = Math.round(performance.now() - observeStart);
		}

		const totalMs = Math.round(performance.now() - startedAt);
		return {
			success: results.every((result) => result.success),
			os: this.platform.os,
			results,
			...(finalObservation ? { observation: finalObservation } : {}),
			timing: {
				actionsMs,
				settleMs,
				observeMs,
				totalMs,
				...(settled !== undefined ? { settled } : {}),
			},
			...(stoppedAt !== undefined ? { stoppedAt } : {}),
		};
	}

	async dispose(): Promise<void> {
		const platform = this.platformInstance;
		this.platformInstance = this.options.platform ?? null;
		this.observers.clear();
		this.sessionStates.clear();
		this.lastObservation = null;
		await platform?.dispose();
	}

	private observerFor(sessionId: string): ComputerObserver {
		let observer = this.observers.get(sessionId);
		if (observer) {
			this.observers.delete(sessionId);
			this.observers.set(sessionId, observer);
		} else {
			observer = new ComputerObserver(sessionId, this.platform);
			this.observers.set(sessionId, observer);
		}
		return observer;
	}

	private stateFor(sessionId: string): ComputerSessionState {
		let state = this.sessionStates.get(sessionId);
		if (state) {
			this.sessionStates.delete(sessionId);
			this.sessionStates.set(sessionId, state);
		} else {
			state = {
				lastObservation: null,
				liveElements: null,
				elementsDirty: false,
			};
			this.sessionStates.set(sessionId, state);
		}
		while (this.sessionStates.size > MAX_SESSION_STATES) {
			const oldest = this.sessionStates.keys().next().value;
			if (oldest === undefined) break;
			this.sessionStates.delete(oldest);
			this.observers.delete(oldest);
		}
		return state;
	}

	private remember(
		state: ComputerSessionState,
		observation: ComputerObservation,
	): void {
		state.lastObservation = observation;
		state.liveElements = observation.elements;
		state.elementsDirty = false;
		this.lastObservation = observation;
	}

	private async executeOne(
		action: ComputerAction,
		ctx: ToolContext,
		observer: ComputerObserver,
		state: ComputerSessionState,
	): Promise<{
		result: Omit<ComputerActionResult, "durationMs">;
		observation?: ComputerObservation;
	}> {
		try {
			switch (action.action) {
				case "screenshot": {
					const observation = await observer.observe(ctx.signal);
					this.remember(state, observation);
					return {
						result: {
							success: true,
							action: action.action,
							summary: observation.summary,
						},
						observation,
					};
				}
				case "zoom": {
					if (!state.lastObservation) {
						throw new Error(
							"Take a screenshot before zooming so the region is in a known coordinate space.",
						);
					}
					if (state.elementsDirty) {
						try {
							const fresh = await observer.accessibility(ctx.signal);
							state.liveElements = refreshElementBounds(
								state.liveElements ?? state.lastObservation.elements,
								fresh.elements,
							);
						} catch (err) {
							if (ctx.signal.aborted) throw err;
						}
						state.elementsDirty = false;
					}
					const observation = await observer.observe(ctx.signal, {
						region: action.region,
					});
					// A zoom does not replace the full-screen element list.
					const zoomObservation = {
						...observation,
						elements: state.liveElements ?? state.lastObservation.elements,
					};
					state.lastObservation = {
						...state.lastObservation,
						screenSize: observation.screenSize,
					};
					this.lastObservation = zoomObservation;
					return {
						result: {
							success: true,
							action: action.action,
							summary: observation.summary,
						},
						observation: zoomObservation,
					};
				}
				case "wait":
					await delay(action.durationMs, ctx.signal);
					state.elementsDirty = true;
					return {
						result: {
							success: true,
							action: action.action,
							summary: `Waited ${action.durationMs}ms.`,
						},
					};
				default: {
					const resolver = await this.resolverFor(action, ctx, observer, state);
					const platformAction = toPlatformAction(action, resolver);
					await this.platform.execute(platformAction, ctx.signal);
					return {
						result: {
							success: true,
							action: action.action,
							summary: describeAction(action),
						},
					};
				}
			}
		} catch (err) {
			if (ctx.signal.aborted) throw err;
			return {
				result: {
					success: false,
					action: action.action,
					summary: `Failed to ${action.action}.`,
					error: errorMessage(err),
				},
			};
		}
	}

	/**
	 * Element ids come from the last full observation. Once a state-changing
	 * action has run, refresh their bounds from a fresh accessibility tree so a
	 * batch like [click field, type, click Save] still lands on "Save" after
	 * the layout shifts.
	 */
	private async resolverFor(
		action: ComputerAction,
		ctx: ToolContext,
		observer: ComputerObserver,
		state: ComputerSessionState,
	): Promise<ObservationTargetResolver> {
		if (state.lastObservation && state.elementsDirty && usesElementId(action)) {
			try {
				const fresh = await observer.accessibility(ctx.signal);
				state.liveElements = refreshElementBounds(
					state.liveElements ?? state.lastObservation.elements,
					fresh.elements,
				);
			} catch (err) {
				if (ctx.signal.aborted) throw err;
				// Fall back to the previous bounds.
			}
			state.elementsDirty = false;
		}
		return new ObservationTargetResolver(
			state.lastObservation,
			state.liveElements,
		);
	}
}

function usesElementId(action: ComputerAction): boolean {
	const targets: unknown[] = [];
	if ("target" in action && action.target) targets.push(action.target);
	if ("from" in action) targets.push(action.from, action.to);
	return targets.some(
		(target) =>
			typeof target === "object" && target !== null && "elementId" in target,
	);
}

export function describeAction(action: ComputerAction): string {
	switch (action.action) {
		case "screenshot":
			return "Captured screenshot.";
		case "zoom":
			return "Zoomed in.";
		case "click": {
			const count =
				action.count === 2
					? "Double-clicked"
					: action.count === 3
						? "Triple-clicked"
						: "Clicked";
			const button =
				action.button && action.button !== "left" ? ` (${action.button})` : "";
			return `${count}${button} ${describeTarget(action.target)}.`;
		}
		case "move":
			return `Moved cursor to ${describeTarget(action.target)}.`;
		case "drag":
			return `Dragged from ${describeTarget(action.from)} to ${describeTarget(action.to)}.`;
		case "scroll":
			return `Scrolled ${action.direction} ${action.amount ?? 3}${action.target ? ` at ${describeTarget(action.target)}` : ""}.`;
		case "type":
			return `Typed ${JSON.stringify(clip(action.text, 40))}.`;
		case "key":
			return `Pressed ${formatComputerKey(normalizeComputerKey(action.key))}${action.repeat && action.repeat > 1 ? ` x${action.repeat}` : ""}.`;
		case "holdKey":
			return `Held ${formatComputerKey(normalizeComputerKey(action.key))} for ${action.durationMs}ms.`;
		case "wait":
			return `Waited ${action.durationMs}ms.`;
		case "openApp":
			return `Opened ${action.appName}.`;
	}
}

function describeTarget(target: ComputerTarget): string {
	return "elementId" in target
		? target.elementId
		: `(${Math.round(target.x)}, ${Math.round(target.y)})`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	if (signal.aborted) return Promise.reject(new Error("aborted"));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
