import { z } from "zod";
import { ComputerRuntime } from "../core/computer/ComputerRuntime.ts";
import type {
	ComputerAction,
	ComputerQueueResult,
} from "../core/computer/ComputerTypes.ts";
import { stripNullProps, Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

const targetSchema = z.union([
	z.object({ elementId: z.string().min(1) }),
	z.object({ x: z.number(), y: z.number() }),
]);

const buttonSchema = z.enum(["left", "right", "middle"]);
const keyModifierSchema = z.enum(["meta", "control", "alt", "shift"]);
const actionNameSchema = z.enum([
	"screenshot",
	"click",
	"type",
	"key",
	"wait",
	"openApp",
]);
const keySchema = z.object({
	key: z
		.string()
		.min(1)
		.describe("Canonical key name, e.g. L, ENTER, TAB, BACKSPACE."),
	modifiers: z
		.array(keyModifierSchema)
		.describe(
			"Canonical modifiers. Use meta for Command on macOS and Windows key on Windows.",
		)
		.optional(),
});

const actionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("screenshot"),
	}),
	z.object({
		action: z.literal("click"),
		target: targetSchema,
		button: buttonSchema.optional(),
	}),
	z.object({
		action: z.literal("type"),
		text: z.string(),
	}),
	z.object({
		action: z.literal("key"),
		key: keySchema,
	}),
	z.object({
		action: z.literal("wait"),
		durationMs: z.number().int().min(0).max(60_000),
	}),
	z.object({
		action: z.literal("openApp"),
		appName: z.string().min(1),
	}),
]);

const runtimeSchema = z.object({
	actions: z
		.array(actionSchema)
		.min(1)
		.max(20)
		.describe("Serial action queue. Use one action for a single step."),
	defaultDelayMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Delay between queued actions.")
		.optional(),
	stopOnError: z
		.boolean()
		.describe("Stop queued execution after the first failed action.")
		.optional(),
});

const publicTargetSchema = z.object({
	elementId: z
		.string()
		.min(1)
		.describe(
			"Primary target selector. Use an element id from the latest screenshot elements list.",
		)
		.optional(),
	x: z.number().describe("Fallback screen x coordinate.").optional(),
	y: z.number().describe("Fallback screen y coordinate.").optional(),
});

const publicActionSchema = z.object({
	action: actionNameSchema.describe("Action to perform."),
	target: publicTargetSchema
		.describe(
			"For click actions, use target.elementId from the latest screenshot elements list whenever available. Coordinates are fallback only.",
		)
		.optional(),
	button: buttonSchema.optional(),
	text: z.string().describe("Text to type for the type action.").optional(),
	key: keySchema.optional(),
	durationMs: z.number().int().positive().optional(),
	ms: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Alias for durationMs on wait actions.")
		.optional(),
	appName: z
		.string()
		.min(1)
		.describe("Application name for the openApp action.")
		.optional(),
});

const publicSchema = z.object({
	actions: z
		.array(publicActionSchema)
		.min(1)
		.max(20)
		.describe("Serial queue of action objects."),
	defaultDelayMs: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Delay between queued actions.")
		.optional(),
	stopOnError: z
		.boolean()
		.describe("Stop queued execution after the first failed action.")
		.optional(),
});

type Input = z.infer<typeof runtimeSchema>;

export class ComputerTool extends Tool<Input, ComputerQueueResult> {
	readonly name = "Computer";
	readonly inputSchema = publicSchema as z.ZodType<Input>;

	constructor(private readonly runtime = new ComputerRuntime()) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override isDestructive(): boolean {
		return true;
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
		);
	}
}

function computerResultTitle(
	actions: readonly ComputerAction[],
	result: ComputerQueueResult,
): string {
	const last = result.results.at(-1);
	if (!last) return result.success ? "Completed" : "Failed";
	if (!last.success) return `Failed ${last.action}`;
	if (actions.length > 1) return `Completed ${actions.length} actions`;
	switch (actions[0]?.action) {
		case "screenshot":
			return "Captured screenshot";
		case "click":
			return "Clicked";
		case "type":
			return "Typed text";
		case "key":
			return "Pressed key";
		case "wait":
			return `Waited ${actions[0].durationMs}ms`;
		case "openApp":
			return `Opened ${actions[0].appName}`;
		default:
			return "Completed";
	}
}

function normalizeComputerInput(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const input = raw as Record<string, unknown>;
	if (!Array.isArray(input.actions)) return input;
	return {
		...input,
		actions: input.actions.map((action) => {
			if (typeof action === "string") {
				return { action };
			}
			if (!action || typeof action !== "object" || Array.isArray(action)) {
				return action;
			}
			const item = action as Record<string, unknown>;
			let normalized = item;
			if (
				normalized.action === undefined &&
				typeof normalized.type === "string"
			) {
				const { type: actionType, ...rest } = item;
				normalized = { ...rest, action: actionType };
			}
			if (normalized.action === "key" && normalized.key !== undefined) {
				return { ...normalized, key: normalizeKeyInput(normalized.key) };
			}
			if (normalized.action === "wait" && normalized.durationMs === undefined) {
				const durationMs =
					typeof normalized.ms === "number" ? normalized.ms : undefined;
				if (durationMs !== undefined) return { ...normalized, durationMs };
			}
			return normalized;
		}),
	};
}

function normalizeKeyInput(raw: unknown): unknown {
	if (typeof raw === "string") return parseKeyChord(raw);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const key = raw as Record<string, unknown>;
	if (typeof key.key !== "string") return key;
	const parsed = parseKeyChord(key.key);
	const explicitModifiers = Array.isArray(key.modifiers)
		? key.modifiers.map((modifier) =>
				typeof modifier === "string"
					? normalizeModifierInput(modifier)
					: modifier,
			)
		: [];
	return {
		...key,
		key: parsed.key,
		modifiers: [...parsed.modifiers, ...explicitModifiers],
	};
}

function parseKeyChord(value: string): { key: string; modifiers: string[] } {
	const parts = value
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const key = parts.pop() ?? value;
	return {
		key,
		modifiers: parts.map(normalizeModifierInput),
	};
}

function normalizeModifierInput(value: string): string {
	switch (value.toLowerCase()) {
		case "cmd":
		case "command":
		case "meta":
		case "win":
		case "windows":
			return "meta";
		case "ctrl":
		case "control":
			return "control";
		case "alt":
		case "option":
			return "alt";
		case "shift":
			return "shift";
		default:
			return value;
	}
}
