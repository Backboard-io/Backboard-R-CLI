import type { PlatformAction } from "../platform/index.ts";
import { normalizeComputerKey } from "./ComputerKeys.ts";
import type {
	ComputerAction,
	ComputerObservation,
	ComputerTarget,
} from "./ComputerTypes.ts";

type PlatformComputerAction = Exclude<
	ComputerAction,
	{ action: "screenshot" } | { action: "wait" }
>;

export function toPlatformAction(
	action: PlatformComputerAction,
	observation: ComputerObservation | null,
): PlatformAction {
	switch (action.action) {
		case "openApp":
			return { kind: "openApp", appName: action.appName };
		case "type":
			return { kind: "type", text: action.text };
		case "key":
			return { kind: "key", key: normalizeComputerKey(action.key) };
		case "click":
			return {
				kind: "click",
				point: resolveTarget(action.target, observation),
				button: action.button ?? "left",
			};
		default:
			return assertNever(action);
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported computer action: ${JSON.stringify(value)}`);
}

function resolveTarget(
	target: ComputerTarget,
	observation: ComputerObservation | null,
): { x: number; y: number } {
	if ("x" in target) return { x: target.x, y: target.y };
	if (!observation) {
		throw new Error("A fresh screenshot is required before using elementId.");
	}
	const element = observation.elements.find(
		(item) => item.id === target.elementId,
	);
	if (!element) {
		throw new Error(`Unknown elementId: ${target.elementId}`);
	}
	if (!element.bounds) {
		throw new Error(`Element ${target.elementId} does not have screen bounds.`);
	}
	return {
		x: element.bounds.x + element.bounds.width / 2,
		y: element.bounds.y + element.bounds.height / 2,
	};
}
