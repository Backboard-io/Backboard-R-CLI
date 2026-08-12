import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { McpToolRegistrar } from "../src/core/mcp/MCPToolRegistrar.ts";
import type { McpToolDefinition } from "../src/core/mcp/MCPTypes.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";

function fakeMcpTool(name = "mcp__server__inspect"): McpToolDefinition {
	return {
		registeredName: name,
		serverName: "server",
		toolName: "inspect",
		description: "Inspect server state",
		inputSchema: { type: "object", properties: {} },
		trustAnnotations: false,
		timeoutMs: 1_000,
		call: async (_input: Record<string, unknown>, _ctx: ToolContext) => ({
			content: [{ type: "text", text: "ok" }],
		}),
	};
}

describe("McpToolRegistrar", () => {
	it("registers and unregisters MCP tool adapters through the registry", () => {
		const registry = new ToolRegistry();
		const registrar = new McpToolRegistrar(registry, new EventBus());

		const registered = registrar.register({
			tools: [fakeMcpTool()],
			warnings: [],
		});

		expect(registered.toolNames).toEqual(["mcp__server__inspect"]);
		expect(registry.has("mcp__server__inspect")).toBe(true);

		const unregistered = registrar.unregister({
			toolNames: ["mcp__server__inspect"],
			warnings: [],
		});

		expect(unregistered.toolNames).toEqual(["mcp__server__inspect"]);
		expect(registry.has("mcp__server__inspect")).toBe(false);
	});

	it("applies refresh removals before registering changed tools", () => {
		const registry = new ToolRegistry();
		const registrar = new McpToolRegistrar(registry, new EventBus());
		registrar.register({
			tools: [fakeMcpTool("mcp__server__old")],
			warnings: [],
		});

		const result = registrar.applyRefresh({
			removedToolNames: ["mcp__server__old"],
			tools: [fakeMcpTool("mcp__server__new")],
			warnings: [],
		});

		expect(result.toolNames).toEqual(["mcp__server__new"]);
		expect(registry.has("mcp__server__old")).toBe(false);
		expect(registry.has("mcp__server__new")).toBe(true);
	});

	it("emits MCP warnings to the event bus", () => {
		const registry = new ToolRegistry();
		const bus = new EventBus();
		const warnings: string[] = [];
		bus.on("system:warning", (event) => warnings.push(event.message));

		const registrar = new McpToolRegistrar(registry, bus);
		const result = registrar.register({
			tools: [],
			warnings: ["server failed"],
		});

		expect(result.warnings).toEqual(["server failed"]);
		expect(warnings).toEqual(["server failed"]);
	});
});
