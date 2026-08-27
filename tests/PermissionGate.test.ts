import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { EventBus } from "../src/core/bus/EventBus.ts";
import {
	ALLOW_ONCE,
	DENY,
} from "../src/core/permissions/PermissionPrompter.ts";
import { parseRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { PermissionContext } from "../src/core/permissions/types.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { McpToolAdapter } from "../src/tools/MCPToolAdapter.tsx";

const schema = z.object({ value: z.string().optional() });
type Input = z.infer<typeof schema>;

class GatedTool extends Tool<Input, { ran: boolean }> {
	readonly name = "Gated";
	readonly inputSchema = schema;
	ran = false;
	override isReadOnly(): boolean {
		return false;
	}
	override async execute(
		_i: Input,
		_c: ToolContext,
	): Promise<ToolResult<{ ran: boolean }>> {
		this.ran = true;
		return ok({ ran: true }, "ran", "ran");
	}
}

function makeContext(
	permissions: PermissionContext,
	answer: string,
): ToolContext {
	return {
		sessionId: "sess_test",
		cwd: "/tmp",
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => answer,
		permissions,
	};
}

function scheduler(tool: Tool): ToolScheduler {
	const registry = new ToolRegistry();
	registry.register(tool);
	return new ToolScheduler(registry, new EventBus());
}

async function runOne(tool: Tool, ctx: ToolContext) {
	const sched = scheduler(tool);
	return await sched.run(
		[{ id: "call_1", name: tool.agentName, input: {} }],
		ctx,
	);
}

describe("permission gate in the runner", () => {
	it("denied calls return an error output and never execute", async () => {
		const tool = new GatedTool();
		const ctx = makeContext(
			{ mode: "manual", rules: parseRuleSet({}), interactive: true },
			DENY,
		);
		const outputs = await runOne(tool, ctx);
		expect(tool.ran).toBe(false);
		expect(outputs[0]?.output).toContain("denied");
		expect(outputs[0]?.metadata?.error).toBe(true);
	});

	it("allowed calls execute normally", async () => {
		const tool = new GatedTool();
		const ctx = makeContext(
			{ mode: "manual", rules: parseRuleSet({}), interactive: true },
			ALLOW_ONCE,
		);
		const outputs = await runOne(tool, ctx);
		expect(tool.ran).toBe(true);
		expect(outputs[0]?.metadata?.error).toBe(false);
	});

	it("headless asks auto-deny", async () => {
		const tool = new GatedTool();
		const ctx = makeContext(
			{ mode: "manual", rules: parseRuleSet({}), interactive: false },
			ALLOW_ONCE,
		);
		const outputs = await runOne(tool, ctx);
		expect(tool.ran).toBe(false);
		expect(outputs[0]?.output).toContain("unavailable");
	});

	it("contexts without permissions run ungated (existing tests unaffected)", async () => {
		const tool = new GatedTool();
		const ctx = makeContext(undefined as unknown as PermissionContext, DENY);
		ctx.permissions = undefined;
		await runOne(tool, ctx);
		expect(tool.ran).toBe(true);
	});

	it("does not execute unannotated MCP tools headlessly in auto mode", async () => {
		let called = false;
		const tool = new McpToolAdapter({
			registeredName: "mcp__mailer__send_email",
			serverName: "mailer",
			toolName: "send_email",
			description: "Send email",
			inputSchema: { type: "object" },
			trustAnnotations: false,
			timeoutMs: 1_000,
			call: async () => {
				called = true;
				return { content: [] };
			},
		});
		const ctx = makeContext(
			{ mode: "auto", rules: parseRuleSet({}), interactive: false },
			ALLOW_ONCE,
		);

		const outputs = await runOne(tool, ctx);

		expect(called).toBe(false);
		expect(outputs[0]?.output).toContain("unavailable");
		expect(outputs[0]?.metadata?.error).toBe(true);
	});

	it("executes trusted read-only MCP tools headlessly in auto mode", async () => {
		let called = false;
		const tool = new McpToolAdapter({
			registeredName: "mcp__docs__search",
			serverName: "docs",
			toolName: "search",
			description: "Search docs",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
			trustAnnotations: true,
			timeoutMs: 1_000,
			call: async () => {
				called = true;
				return { content: [] };
			},
		});
		const ctx = makeContext(
			{ mode: "auto", rules: parseRuleSet({}), interactive: false },
			DENY,
		);

		const outputs = await runOne(tool, ctx);

		expect(called).toBe(true);
		expect(outputs[0]?.metadata?.error).toBe(false);
	});
});
