import { z } from "zod";
import {
	formatComputerKey,
	normalizeComputerKey,
} from "../core/computer/ComputerKeys.ts";
import { ComputerRuntime } from "../core/computer/ComputerRuntime.ts";
import {
	type ComputerAction,
	type ComputerQueueResult,
	READ_ONLY_COMPUTER_ACTIONS,
} from "../core/computer/ComputerTypes.ts";
import type { PermissionCheckContext } from "../core/permissions/types.ts";
import { stripNullProps, Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const buttonSchema = z.enum(["left", "right", "middle"]);
const modifierSchema = z.enum(["meta", "control", "alt", "shift"]);
const directionSchema = z.enum(["up", "down", "left", "right"]);
const actionNameSchema = z.enum([
	"screenshot",
	"zoom",
	"click",
	"move",
	"drag",
	"scroll",
	"type",
	"key",
	"holdKey",
	"wait",
	"openApp",
]);

const elementTarget = z.object({ elementId: z.string().min(1) });
const pointTarget = z.object({ x: z.number(), y: z.number() });
const targetSchema = z.union([elementTarget, pointTarget]);
const regionSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number().positive(),
	height: z.number().positive(),
});
const keySchema = z.union([
	z.string().min(1),
	z.object({
		key: z.string().min(1),
		modifiers: z.array(z.string()).optional(),
	}),
]);

const actionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("screenshot") }),
	z.object({ action: z.literal("zoom"), region: regionSchema }),
	z.object({
		action: z.literal("click"),
		target: targetSchema,
		button: buttonSchema.optional(),
		count: z.number().int().min(1).max(3).optional(),
		modifiers: z.array(modifierSchema).optional(),
	}),
	z.object({ action: z.literal("move"), target: targetSchema }),
	z.object({
		action: z.literal("drag"),
		from: targetSchema,
		to: targetSchema,
		button: buttonSchema.optional(),
	}),
	z.object({
		action: z.literal("scroll"),
		target: targetSchema.optional(),
		direction: directionSchema,
		amount: z.number().int().min(1).max(50).optional(),
	}),
	z.object({ action: z.literal("type"), text: z.string() }),
	z.object({
		action: z.literal("key"),
		key: keySchema,
		repeat: z.number().int().min(1).max(100).optional(),
	}),
	z.object({
		action: z.literal("holdKey"),
		key: keySchema,
		durationMs: z.number().int().min(1).max(30_000),
	}),
	z.object({
		action: z.literal("wait"),
		durationMs: z.number().int().min(0).max(60_000),
	}),
	z.object({ action: z.literal("openApp"), appName: z.string().min(1) }),
]);

const runtimeSchema = z.object({
	actions: z.array(actionSchema).min(1).max(25),
	defaultDelayMs: z.number().int().min(0).max(60_000).optional(),
	stopOnError: z.boolean().optional(),
});

/**
 * The advertised schema is a single flat object per action: Backboard's
 * function-calling contract rejects `anyOf` unions, so every field is optional
 * here and the discriminated union above validates the parsed input.
 */
const publicTargetSchema = z.object({
	elementId: z
		.string()
		.describe("Element id from the latest screenshot's elements list.")
		.optional(),
	x: z
		.number()
		.describe("X in the latest screenshot's screenSize space.")
		.optional(),
	y: z
		.number()
		.describe("Y in the latest screenshot's screenSize space.")
		.optional(),
});

const publicActionSchema = z.object({
	action: actionNameSchema.describe(
		"screenshot | zoom | click | move | drag | scroll | type | key | holdKey | wait | openApp",
	),
	target: publicTargetSchema
		.describe(
			"click/move/scroll target. Prefer {elementId}; fall back to {x,y}.",
		)
		.optional(),
	from: publicTargetSchema.describe("drag start.").optional(),
	to: publicTargetSchema.describe("drag end.").optional(),
	button: buttonSchema.describe("Mouse button, default left.").optional(),
	count: z
		.number()
		.int()
		.min(1)
		.max(3)
		.describe("Clicks: 1 (default), 2 = double, 3 = triple.")
		.optional(),
	modifiers: z
		.array(modifierSchema)
		.describe("Modifier keys held while clicking.")
		.optional(),
	direction: directionSchema.describe("scroll direction.").optional(),
	amount: z
		.number()
		.int()
		.min(1)
		.max(50)
		.describe("scroll amount in wheel clicks (default 3).")
		.optional(),
	region: regionSchema
		.describe("zoom: region of the screen to view at full resolution.")
		.optional(),
	text: z.string().describe("type: text to enter.").optional(),
	key: z
		.string()
		.describe(
			'key/holdKey: chord such as "ENTER", "cmd+s", "ctrl+shift+t", "F5". meta = Cmd on macOS, Win on Windows.',
		)
		.optional(),
	repeat: z
		.number()
		.int()
		.min(1)
		.max(100)
		.describe("key: press this many times.")
		.optional(),
	durationMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("wait/holdKey duration.")
		.optional(),
	appName: z
		.string()
		.describe("openApp: application name, e.g. Safari, Notes, Terminal.")
		.optional(),
});

const publicSchema = z.object({
	actions: z
		.array(publicActionSchema)
		.min(1)
		.max(25)
		.describe(
			"Actions run in order. Stops at the first failure. The final screen is returned once, after the last action.",
		),
	defaultDelayMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Pause between actions (default 0).")
		.optional(),
	stopOnError: z
		.boolean()
		.describe("Stop at the first failed action (default true).")
		.optional(),
});

type Input = z.infer<typeof runtimeSchema>;

export class ComputerTool extends Tool<Input, ComputerQueueResult> {
	readonly name = "Computer";
	readonly inputSchema = publicSchema as unknown as z.ZodType<Input>;

	constructor(private readonly runtime = new ComputerRuntime()) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(input: Input): boolean {
		return input.actions.every((action) =>
			READ_ONLY_COMPUTER_ACTIONS.has(action.action),
		);
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override isDestructive(input: Input): boolean {
		return !this.isReadOnly(input);
	}

	override checkPermissions(
		input: Input,
		_ctx: PermissionCheckContext,
	): undefined {
		void input;
		return undefined;
	}

	override summarizeInput(input: Input): string {
		return input.actions.map(summarizeAction).join(" · ");
	}

	override permissionHint(input: Input): string | undefined {
		const sensitive = input.actions.some(
			(action) => action.action === "type" && looksSecret(action.text),
		);
		return sensitive
			? "This batch types text that looks like a credential."
			: undefined;
	}

	override parseInput(raw: unknown): Input {
		return runtimeSchema.parse(normalizeComputerInput(stripNullProps(raw)));
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<ComputerQueueResult>> {
		const result = await this.runtime.execute(input.actions, ctx, {
			defaultDelayMs: input.defaultDelayMs,
			stopOnError: input.stopOnError,
		});
		return ok(
			result,
			JSON.stringify(result),
			computerResultTitle(input.actions, result),
			computerResultDetail(result),
		);
	}

	override async dispose(): Promise<void> {
		await this.runtime.dispose();
	}
}

function computerResultTitle(
	actions: readonly ComputerAction[],
	result: ComputerQueueResult,
): string {
	if (result.stoppedAt !== undefined) {
		const failed = result.results[result.stoppedAt];
		return `Failed ${failed?.action ?? "action"}${actions.length > 1 ? ` (${result.stoppedAt + 1}/${actions.length})` : ""}`;
	}
	if (!result.success) return "Failed";
	if (actions.length > 1) {
		return `Ran ${actions.length} actions in ${formatMs(result.timing.totalMs)}`;
	}
	const [only] = actions;
	if (!only) return "Completed";
	return `${summarizeAction(only)} in ${formatMs(result.timing.totalMs)}`;
}

function computerResultDetail(result: ComputerQueueResult): string | undefined {
	const lines = result.results.map((entry) =>
		entry.success
			? `✓ ${entry.summary}`
			: `✗ ${entry.summary}${entry.error ? ` ${entry.error}` : ""}`,
	);
	const observation = result.observation;
	if (observation) {
		lines.push(
			`${observation.appName ?? "screen"}${observation.windowTitle ? ` — ${observation.windowTitle}` : ""} · ${observation.elements.length} elements · ${observation.imageSize.width}x${observation.imageSize.height}`,
		);
	}
	return lines.join("\n");
}

function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function summarizeAction(action: ComputerAction): string {
	switch (action.action) {
		case "screenshot":
			return "screenshot";
		case "zoom":
			return `zoom ${Math.round(action.region.width)}x${Math.round(action.region.height)}`;
		case "click": {
			const kind =
				action.count === 2
					? "double-click"
					: action.count === 3
						? "triple-click"
						: "click";
			const button =
				action.button && action.button !== "left" ? `${action.button}-` : "";
			return `${button}${kind} ${describeTarget(action.target)}`;
		}
		case "move":
			return `move ${describeTarget(action.target)}`;
		case "drag":
			return `drag ${describeTarget(action.from)} → ${describeTarget(action.to)}`;
		case "scroll":
			return `scroll ${action.direction}${action.target ? ` at ${describeTarget(action.target)}` : ""}`;
		case "type":
			return `type ${JSON.stringify(clip(action.text, 30))}`;
		case "key":
			return `key ${formatComputerKey(normalizeComputerKey(action.key))}${action.repeat && action.repeat > 1 ? ` x${action.repeat}` : ""}`;
		case "holdKey":
			return `hold ${formatComputerKey(normalizeComputerKey(action.key))} ${action.durationMs}ms`;
		case "wait":
			return `wait ${action.durationMs}ms`;
		case "openApp":
			return `open ${action.appName}`;
	}
}

function describeTarget(
	target: { elementId: string } | { x: number; y: number },
): string {
	return "elementId" in target
		? target.elementId
		: `(${Math.round(target.x)}, ${Math.round(target.y)})`;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function looksSecret(text: string): boolean {
	return (
		/^(sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/.test(text) ||
		/^[A-Za-z0-9+/=_-]{24,}$/.test(text)
	);
}

/**
 * Provider-style action names models emit from their training data. Mapped
 * onto the canonical actions so a model that speaks Anthropic's or OpenAI's
 * computer-use dialect still works.
 */
const ACTION_ALIASES: Record<string, Partial<Record<string, unknown>>> = {
	left_click: { action: "click" },
	right_click: { action: "click", button: "right" },
	middle_click: { action: "click", button: "middle" },
	double_click: { action: "click", count: 2 },
	doubleclick: { action: "click", count: 2 },
	triple_click: { action: "click", count: 3 },
	mouse_move: { action: "move" },
	hover: { action: "move" },
	left_click_drag: { action: "drag" },
	drag_and_drop: { action: "drag" },
	keypress: { action: "key" },
	hotkey: { action: "key" },
	press_key: { action: "key" },
	hold_key: { action: "holdKey" },
	open_app: { action: "openApp" },
	launch: { action: "openApp" },
	take_screenshot: { action: "screenshot" },
	scroll_up: { action: "scroll", direction: "up" },
	scroll_down: { action: "scroll", direction: "down" },
	scroll_left: { action: "scroll", direction: "left" },
	scroll_right: { action: "scroll", direction: "right" },
};

export function normalizeComputerInput(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const input = raw as Record<string, unknown>;
	if (!Array.isArray(input.actions)) return input;
	return {
		...input,
		actions: input.actions.map(normalizeAction),
	};
}

function normalizeAction(raw: unknown): unknown {
	if (typeof raw === "string") return normalizeAction({ action: raw });
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	let item = stripNullProps(raw) as Record<string, unknown>;
	if (item.action === undefined && typeof item.type === "string") {
		const { type, ...rest } = item;
		item = { ...rest, action: type };
	}
	if (typeof item.action === "string") {
		const alias = ACTION_ALIASES[item.action.toLowerCase()];
		if (alias) item = { ...item, ...alias };
		else if (item.action !== item.action.toLowerCase()) {
			item = { ...item, action: canonicalActionName(item.action) };
		}
	}
	item = normalizeTargets(item);
	if (item.action === "key" || item.action === "holdKey") {
		if (item.key !== undefined)
			item = { ...item, key: normalizeKeyInput(item.key) };
		else if (typeof item.text === "string") {
			const { text, ...rest } = item;
			item = { ...rest, key: normalizeKeyInput(text) };
		}
		if (Array.isArray(item.keys)) {
			const { keys, ...rest } = item;
			item = { ...rest, key: (keys as unknown[]).map(String).join("+") };
		}
		if (item.action === "holdKey" && item.durationMs === undefined) {
			const seconds =
				typeof item.duration === "number" ? item.duration : undefined;
			if (seconds !== undefined)
				item = { ...item, durationMs: Math.round(seconds * 1000) };
		}
	}
	if (item.action === "wait" && item.durationMs === undefined) {
		if (typeof item.ms === "number") item = { ...item, durationMs: item.ms };
		else if (typeof item.duration === "number") {
			item = { ...item, durationMs: Math.round(item.duration * 1000) };
		} else item = { ...item, durationMs: 1000 };
	}
	if (item.action === "scroll") {
		if (
			item.direction === undefined &&
			typeof item.scroll_direction === "string"
		) {
			item = { ...item, direction: item.scroll_direction };
		}
		if (item.amount === undefined && typeof item.scroll_amount === "number") {
			item = { ...item, amount: item.scroll_amount };
		}
		if (item.direction === undefined) {
			const dy = typeof item.scroll_y === "number" ? item.scroll_y : 0;
			const dx = typeof item.scroll_x === "number" ? item.scroll_x : 0;
			if (dy !== 0)
				item = {
					...item,
					direction: dy > 0 ? "down" : "up",
					amount: Math.max(1, Math.round(Math.abs(dy) / 40)),
				};
			else if (dx !== 0)
				item = {
					...item,
					direction: dx > 0 ? "right" : "left",
					amount: Math.max(1, Math.round(Math.abs(dx) / 40)),
				};
		}
	}
	if (
		item.action === "type" &&
		item.text === undefined &&
		typeof item.value === "string"
	) {
		item = { ...item, text: item.value };
	}
	if (
		item.action === "zoom" &&
		item.region === undefined &&
		Array.isArray(item.regionBox)
	) {
		const [x0, y0, x1, y1] = item.regionBox as number[];
		if ([x0, y0, x1, y1].every((n) => typeof n === "number")) {
			item = {
				...item,
				region: {
					x: x0,
					y: y0,
					width: (x1 as number) - (x0 as number),
					height: (y1 as number) - (y0 as number),
				},
			};
		}
	}
	return item;
}

function canonicalActionName(name: string): string {
	const lower = name.toLowerCase();
	if (lower === "holdkey") return "holdKey";
	if (lower === "openapp") return "openApp";
	return lower;
}

/** Accepts `coordinate: [x, y]`, top-level `x`/`y`, and `start_coordinate`. */
function normalizeTargets(
	item: Record<string, unknown>,
): Record<string, unknown> {
	let out = { ...item };
	const fromCoordinate = (value: unknown): Record<string, number> | null => {
		if (
			Array.isArray(value) &&
			value.length === 2 &&
			value.every((n) => typeof n === "number")
		) {
			return { x: value[0] as number, y: value[1] as number };
		}
		return null;
	};
	if (out.action === "drag") {
		if (out.from === undefined) {
			const start =
				fromCoordinate(out.start_coordinate) ??
				fromCoordinate(out.from_coordinate);
			if (start) out = { ...out, from: start };
			else if (Array.isArray(out.path) && out.path.length >= 2) {
				out = { ...out, from: out.path[0], to: out.path[out.path.length - 1] };
			}
		}
		if (out.to === undefined) {
			const end =
				fromCoordinate(out.coordinate) ?? fromCoordinate(out.end_coordinate);
			if (end) out = { ...out, to: end };
		}
		out = { ...out, from: cleanTarget(out.from), to: cleanTarget(out.to) };
		return out;
	}
	if (out.target === undefined) {
		const point = fromCoordinate(out.coordinate);
		if (point) out = { ...out, target: point };
		else if (typeof out.x === "number" && typeof out.y === "number") {
			out = { ...out, target: { x: out.x, y: out.y } };
		} else if (typeof out.elementId === "string") {
			out = { ...out, target: { elementId: out.elementId } };
		} else if (typeof out.element_id === "string") {
			out = { ...out, target: { elementId: out.element_id } };
		}
	}
	if (out.target !== undefined)
		out = { ...out, target: cleanTarget(out.target) };
	return out;
}

/** `{elementId, x, y}` with unset members → one of the two target shapes. */
function cleanTarget(target: unknown): unknown {
	if (!target || typeof target !== "object" || Array.isArray(target))
		return target;
	const value = stripNullProps(target) as Record<string, unknown>;
	if (typeof value.elementId === "string" && value.elementId) {
		return { elementId: value.elementId };
	}
	if (typeof value.element_id === "string" && value.element_id) {
		return { elementId: value.element_id };
	}
	if (typeof value.x === "number" && typeof value.y === "number") {
		return { x: value.x, y: value.y };
	}
	return value;
}

function normalizeKeyInput(raw: unknown): unknown {
	if (typeof raw === "string") return raw;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const key = raw as Record<string, unknown>;
	if (typeof key.key !== "string") return key;
	return {
		key: key.key,
		modifiers: Array.isArray(key.modifiers) ? key.modifiers.map(String) : [],
	};
}
