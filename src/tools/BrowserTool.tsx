import { z } from "zod";
import { BrowserRuntime } from "../core/browser/BrowserRuntime.ts";
import type {
	BrowserAction,
	BrowserQueueResult,
} from "../core/browser/BrowserTypes.ts";
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
	"navigate",
	"click",
	"type",
	"key",
	"wait",
]);
const actionSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("screenshot"),
	}),
	z.object({
		action: z.literal("navigate"),
		url: z.string().url(),
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
		key: z.string().min(1),
		modifiers: z.array(keyModifierSchema).optional(),
	}),
	z.object({
		action: z.literal("wait"),
		durationMs: z.number().int().min(0).max(60_000),
	}),
]);

const runtimeSchema = z.object({
	actions: z
		.array(actionSchema)
		.min(1)
		.max(20)
		.describe("Serial browser action queue. Use one action for a single step."),
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
			"Primary target selector. Use an element id from the latest Browser screenshot elements list.",
		)
		.optional(),
	x: z.number().describe("Fallback page x coordinate.").optional(),
	y: z.number().describe("Fallback page y coordinate.").optional(),
});

const publicActionSchema = z.object({
	action: actionNameSchema.describe("Browser action to perform."),
	url: z
		.string()
		.url()
		.describe("Absolute URL for the navigate action.")
		.optional(),
	elementId: z
		.string()
		.min(1)
		.describe(
			"For click actions, use an element id from the latest Browser screenshot elements list.",
		)
		.optional(),
	x: z
		.number()
		.describe("Fallback page x coordinate for click actions.")
		.optional(),
	y: z
		.number()
		.describe("Fallback page y coordinate for click actions.")
		.optional(),
	target: publicTargetSchema
		.describe(
			"For click actions, use target.elementId from the latest Browser screenshot elements list whenever available. Coordinates are fallback only.",
		)
		.optional(),
	button: buttonSchema.optional(),
	text: z.string().describe("Text to type for the type action.").optional(),
	key: z
		.string()
		.min(1)
		.describe(
			"For key actions, pass a key name string such as k, ENTER, TAB, BACKSPACE.",
		)
		.optional(),
	modifiers: z
		.array(keyModifierSchema)
		.describe("Optional modifiers for key actions when key is a string.")
		.optional(),
	durationMs: z.number().int().min(1).optional(),
	ms: z
		.number()
		.int()
		.min(0)
		.max(60_000)
		.describe("Alias for durationMs on wait actions.")
		.optional(),
});

const publicSchema = z.object({
	actions: z
		.array(publicActionSchema)
		.min(1)
		.max(20)
		.describe("Serial queue of Browser action objects."),
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

export class BrowserTool extends Tool<Input, BrowserQueueResult> {
	readonly name = "Browser";
	readonly inputSchema = publicSchema as z.ZodType<Input>;

	constructor(private readonly runtime = new BrowserRuntime()) {
		super();
	}

	override async dispose(): Promise<void> {
		await this.runtime.dispose();
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
		return runtimeSchema.parse(normalizeBrowserInput(stripNullProps(raw)));
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<BrowserQueueResult>> {
		const result = await this.runtime.execute(input.actions, ctx, {
			defaultDelayMs: input.defaultDelayMs,
			stopOnError: input.stopOnError,
		});
		return ok(
			result,
			JSON.stringify(result),
			browserResultTitle(input.actions, result),
		);
	}
}

function browserResultTitle(
	actions: readonly BrowserAction[],
	result: BrowserQueueResult,
): string {
	const last = result.results.at(-1);
	if (!last) return result.success ? "Completed" : "Failed";
	if (!last.success) return `Failed ${last.action}`;
	if (actions.length > 1) {
		return `Completed ${actions.length} actions`;
	}
	switch (actions[0]?.action) {
		case "screenshot":
			return "Captured screenshot";
		case "navigate":
			return "Navigated";
		case "click":
			return "Clicked";
		case "type":
			return "Typed text";
		case "key":
			return "Pressed key";
		case "wait":
			return `Waited ${actions[0].durationMs}ms`;
		default:
			return "Completed";
	}
}

function normalizeBrowserInput(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const input = raw as Record<string, unknown>;
	if (!Array.isArray(input.actions)) return input;
	return {
		...input,
		actions: input.actions.map((action) => {
			if (!action || typeof action !== "object" || Array.isArray(action)) {
				return action;
			}
			const item = action as Record<string, unknown>;
			let normalized = item;
			if (item.action === undefined && typeof item.type === "string") {
				const { type, ...rest } = item;
				normalized = { ...rest, action: type };
			}
			if (normalized.action === "wait" && normalized.durationMs === undefined) {
				const durationMs =
					typeof normalized.ms === "number" ? normalized.ms : undefined;
				if (durationMs !== undefined) return { ...normalized, durationMs };
			}
			if (normalized.action === "click" && normalized.target === undefined) {
				const target = browserTargetFromFlatFields(normalized);
				if (target) return { ...normalized, target };
			}
			return normalized;
		}),
	};
}

function browserTargetFromFlatFields(
	input: Record<string, unknown>,
): unknown | null {
	if (typeof input.elementId === "string" && input.elementId.length > 0) {
		return { elementId: input.elementId };
	}
	if (typeof input.x === "number" && typeof input.y === "number") {
		return { x: input.x, y: input.y };
	}
	return null;
}
