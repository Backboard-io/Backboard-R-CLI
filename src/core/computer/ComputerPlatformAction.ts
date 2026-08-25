import type {
	AccessibilityElement,
	PlatformAction,
	ScreenPoint,
} from "../platform/index.ts";
import { normalizeComputerKey } from "./ComputerKeys.ts";
import type {
	ComputerAction,
	ComputerObservation,
	ComputerTarget,
	ScrollDirection,
} from "./ComputerTypes.ts";

type PlatformComputerAction = Exclude<
	ComputerAction,
	{ action: "screenshot" } | { action: "zoom" } | { action: "wait" }
>;

export interface TargetResolver {
	resolve(target: ComputerTarget): ScreenPoint;
}

export function toPlatformAction(
	action: PlatformComputerAction,
	targets: TargetResolver,
): PlatformAction {
	switch (action.action) {
		case "openApp":
			return { kind: "openApp", appName: action.appName };
		case "type":
			return { kind: "type", text: action.text };
		case "key":
			return {
				kind: "key",
				key: normalizeComputerKey(action.key),
				...(action.repeat ? { repeat: action.repeat } : {}),
			};
		case "holdKey":
			return {
				kind: "holdKey",
				key: normalizeComputerKey(action.key),
				durationMs: action.durationMs,
			};
		case "click":
			return {
				kind: "click",
				point: targets.resolve(action.target),
				button: action.button ?? "left",
				count: action.count ?? 1,
				modifiers: action.modifiers ?? [],
			};
		case "move":
			return { kind: "move", point: targets.resolve(action.target) };
		case "drag":
			return {
				kind: "drag",
				from: targets.resolve(action.from),
				to: targets.resolve(action.to),
				button: action.button ?? "left",
			};
		case "scroll": {
			const amount = Math.max(1, Math.round(action.amount ?? 3));
			const [dx, dy] = scrollDelta(action.direction, amount);
			return {
				kind: "scroll",
				...(action.target ? { point: targets.resolve(action.target) } : {}),
				dx,
				dy,
			};
		}
		default:
			return assertNever(action);
	}
}

function scrollDelta(
	direction: ScrollDirection,
	amount: number,
): [number, number] {
	switch (direction) {
		case "up":
			return [0, -amount];
		case "down":
			return [0, amount];
		case "left":
			return [-amount, 0];
		case "right":
			return [amount, 0];
	}
}

function assertNever(value: never): never {
	throw new Error(`Unsupported computer action: ${JSON.stringify(value)}`);
}

/**
 * Maps `elementId` / `{x, y}` targets onto screen points using the latest
 * observation. Coordinates are validated against the observation's
 * `screenSize` so an off-screen click fails loudly instead of landing on
 * another display.
 */
export class ObservationTargetResolver implements TargetResolver {
	constructor(
		private readonly observation: ComputerObservation | null,
		private readonly elements: AccessibilityElement[] | null = null,
	) {}

	resolve(target: ComputerTarget): ScreenPoint {
		const observation = this.observation;
		if (!observation) {
			throw new Error(
				'A screenshot is required before targeting the screen. Queue {"action":"screenshot"} first.',
			);
		}
		if ("x" in target) {
			const { width, height } = observation.screenSize;
			if (
				!Number.isFinite(target.x) ||
				!Number.isFinite(target.y) ||
				target.x < 0 ||
				target.y < 0 ||
				target.x >= width ||
				target.y >= height
			) {
				throw new Error(
					`Coordinates (${target.x}, ${target.y}) are outside the ${width}x${height} screen. Use the screenSize space of the latest screenshot.`,
				);
			}
			return { x: target.x, y: target.y };
		}
		const element = (this.elements ?? observation.elements).find(
			(item) => item.id === target.elementId,
		);
		if (!element) {
			throw new Error(
				`Unknown elementId "${target.elementId}". Use an id from the latest screenshot's elements, or x/y coordinates.`,
			);
		}
		if (!element.bounds) {
			throw new Error(`Element ${target.elementId} has no screen bounds.`);
		}
		const point = {
			x: element.bounds.x + element.bounds.width / 2,
			y: element.bounds.y + element.bounds.height / 2,
		};
		const { width, height } = observation.screenSize;
		if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
			throw new Error(
				`Element ${target.elementId} is centered outside the ${width}x${height} screen.`,
			);
		}
		return point;
	}
}

/**
 * After a state-changing action, elements referenced by id may have moved.
 * Given a fresh accessibility tree, returns the old element list with bounds
 * refreshed for every element that can still be identified (same role and
 * name, or same role and overlapping position).
 */
export function refreshElementBounds(
	previous: AccessibilityElement[],
	fresh: AccessibilityElement[],
): AccessibilityElement[] {
	const used = new Set<string>();
	return previous.map((element) => {
		const previousBounds = element.bounds;
		const named = fresh.filter(
			(candidate) =>
				!used.has(candidate.id) &&
				candidate.role === element.role &&
				candidate.name !== undefined &&
				candidate.name === element.name &&
				candidate.bounds,
		);
		const byName =
			named.length === 1
				? named[0]
				: previousBounds
					? named.find(
							(candidate) =>
								candidate.bounds && overlaps(candidate.bounds, previousBounds),
						)
					: undefined;
		const match =
			byName ??
			fresh.find(
				(candidate) =>
					!used.has(candidate.id) &&
					candidate.role === element.role &&
					(element.name === undefined ||
						candidate.name === undefined ||
						candidate.name === element.name) &&
					candidate.bounds &&
					element.bounds &&
					overlaps(candidate.bounds, element.bounds),
			);
		if (!match?.bounds) return { ...element, bounds: undefined };
		used.add(match.id);
		return { ...element, bounds: match.bounds };
	});
}

function overlaps(
	a: NonNullable<AccessibilityElement["bounds"]>,
	b: NonNullable<AccessibilityElement["bounds"]>,
): boolean {
	return (
		a.x < b.x + b.width &&
		a.x + a.width > b.x &&
		a.y < b.y + b.height &&
		a.y + a.height > b.y
	);
}
