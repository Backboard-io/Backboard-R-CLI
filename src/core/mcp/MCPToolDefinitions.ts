import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
	Tool as SdkTool,
	ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";
import type { McpListedToolDefinition, McpToolDefinition } from "./MCPTypes.ts";
import { mcpFunctionName } from "./name.ts";

type McpListToolsResult = Awaited<ReturnType<Client["listTools"]>>;

export async function listMcpServerToolDefinitions(
	server: McpServerConfig,
	client: Client,
	signal: AbortSignal,
): Promise<McpListedToolDefinition[]> {
	const tools: SdkTool[] = [];
	let cursor: string | undefined;
	do {
		const listed: McpListToolsResult = await client.listTools(
			cursor ? { cursor } : {},
			{ signal, timeout: server.timeoutMs },
		);
		tools.push(...listed.tools);
		cursor = listed.nextCursor;
	} while (cursor);
	return mapMcpTools(server, client, tools);
}

export async function listMcpServerToolDefinitionsIfSupported(
	server: McpServerConfig,
	client: Client,
	capabilities: ServerCapabilities,
	signal: AbortSignal,
): Promise<McpListedToolDefinition[]> {
	if (!capabilities.tools) return [];
	return listMcpServerToolDefinitions(server, client, signal);
}

export function mapMcpTools(
	server: McpServerConfig,
	client: Client,
	tools: readonly SdkTool[],
): McpListedToolDefinition[] {
	return tools
		.filter((tool) => isMcpToolEnabled(tool.name, server))
		.map((tool) => ({
			serverName: server.name,
			toolName: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			annotations: tool.annotations,
			trustAnnotations: server.trustToolAnnotations,
			timeoutMs: server.timeoutMs,
			call: async (input, ctx) =>
				client.callTool({ name: tool.name, arguments: input }, undefined, {
					signal: ctx.signal,
					timeout: server.timeoutMs,
				}),
		}));
}

export function isMcpToolEnabled(
	toolName: string,
	server: Pick<McpServerConfig, "enabledTools" | "disabledTools">,
): boolean {
	if (server.enabledTools !== undefined) {
		return server.enabledTools.includes(toolName);
	}
	return !server.disabledTools.includes(toolName);
}

export function filterMcpListedToolDefinitions(
	server: Pick<McpServerConfig, "enabledTools" | "disabledTools">,
	tools: readonly McpListedToolDefinition[],
): McpListedToolDefinition[] {
	return tools.filter((tool) => isMcpToolEnabled(tool.toolName, server));
}

export function uniqueMcpRegisteredName(
	serverName: string,
	toolName: string,
	seen: Set<string>,
	warnings: string[],
): string | null {
	const plain = mcpFunctionName(serverName, toolName);
	if (!seen.has(plain)) return plain;

	const hashed = mcpFunctionName(serverName, toolName, { hashed: true });
	if (!seen.has(hashed)) return hashed;

	warnings.push(
		`Skipped MCP tool '${serverName}.${toolName}': generated tool name collision.`,
	);
	return null;
}

export function mcpToolDefinitionChanged(
	current: McpToolDefinition,
	next: McpListedToolDefinition,
): boolean {
	return (
		current.description !== next.description ||
		current.timeoutMs !== next.timeoutMs ||
		JSON.stringify(current.inputSchema) !== JSON.stringify(next.inputSchema) ||
		JSON.stringify(current.annotations ?? null) !==
			JSON.stringify(next.annotations ?? null)
	);
}
