import { describe, expect, it } from "bun:test";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../src/core/mcp/config.ts";
import { createMcpTransport } from "../src/core/mcp/MCPTransport.ts";

function stdioConfig(
	overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
	return {
		name: "srv",
		type: "stdio",
		disabled: false,
		configSources: [],
		args: [],
		env: {},
		headers: {},
		disabledTools: [],
		disabledPrompts: [],
		disabledResources: [],
		timeoutMs: 1_000,
		trustToolAnnotations: false,
		...overrides,
	};
}

function httpConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
	return stdioConfig({ type: "http", ...overrides });
}

describe("createMcpTransport", () => {
	it("builds a stdio transport for stdio servers", () => {
		const transport = createMcpTransport(
			stdioConfig({
				command: "node",
				args: ["server.js"],
				env: { FOO: "bar" },
			}),
			"/cwd",
		);
		expect(transport).toBeInstanceOf(StdioClientTransport);
	});

	it("builds an http transport for http servers with headers", () => {
		const transport = createMcpTransport(
			httpConfig({
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer token" },
			}),
			"/cwd",
		);
		expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	it("builds an http transport without headers when none are set", () => {
		const transport = createMcpTransport(
			httpConfig({ url: "https://example.com/mcp" }),
			"/cwd",
		);
		expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
	});

	it("forwards an auth provider to the http transport", () => {
		const transport = createMcpTransport(
			httpConfig({ url: "https://example.com/mcp" }),
			"/cwd",
			{} as never,
		);
		expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
	});
});
