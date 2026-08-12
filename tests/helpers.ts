import { z } from "zod";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";

const schema = z.object({ value: z.string().optional() });
type Input = z.infer<typeof schema>;

export interface TestToolOptions {
	name: string;
	readOnly?: boolean;
	delayMs?: number;
	onStart?: (name: string) => void;
	onEnd?: (name: string) => void;
	throws?: boolean;
}

export class TestTool extends Tool<Input, { value: string }> {
	readonly name: string;
	readonly inputSchema = schema;

	constructor(private readonly opts: TestToolOptions) {
		super();
		this.name = opts.name;
	}

	override isReadOnly(): boolean {
		return this.opts.readOnly ?? true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<{ value: string }>> {
		this.opts.onStart?.(this.name);
		if (this.opts.delayMs) {
			await new Promise((r) => setTimeout(r, this.opts.delayMs));
		}
		if (ctx.signal.aborted) throw new Error("aborted");
		if (this.opts.throws) throw new Error("tool failed");
		this.opts.onEnd?.(this.name);
		const value = input.value ?? this.name;
		return ok({ value }, value, `ran ${this.name}`);
	}
}

export function makeContext(
	signal: AbortSignal,
	bus = new EventBus(),
): ToolContext {
	return {
		sessionId: "sess_test",
		cwd: process.cwd(),
		bus,
		signal,
		askUser: async () => "noop",
	};
}
