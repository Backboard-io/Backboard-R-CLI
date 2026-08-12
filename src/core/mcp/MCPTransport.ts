import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "./config.ts";
import type { McpClientTransport } from "./MCPTypes.ts";

export function createMcpTransport(
	server: McpServerConfig,
	cwd: string,
	authProvider?: OAuthClientProvider,
): McpClientTransport {
	if (server.type === "stdio") {
		return new StdioClientTransport({
			command: server.command ?? "",
			args: server.args,
			env: { ...getDefaultEnvironment(), ...server.env },
			cwd: server.cwd ?? cwd,
			stderr: "pipe",
		});
	}

	return new StreamableHTTPClientTransport(new URL(server.url ?? ""), {
		authProvider,
		requestInit:
			Object.keys(server.headers).length > 0
				? { headers: server.headers }
				: undefined,
	});
}
