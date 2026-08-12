import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Prompt as SdkPrompt } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";
import type { McpPromptDefinition } from "./MCPTypes.ts";

type McpListPromptsResult = Awaited<ReturnType<Client["listPrompts"]>>;
export type McpPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;

export async function listMcpServerPromptDefinitions(
	server: McpServerConfig,
	client: Client,
	signal: AbortSignal,
): Promise<McpPromptDefinition[]> {
	const prompts: SdkPrompt[] = [];
	let cursor: string | undefined;
	do {
		const listed: McpListPromptsResult = await client.listPrompts(
			cursor ? { cursor } : {},
			{ signal, timeout: server.timeoutMs },
		);
		prompts.push(...listed.prompts);
		cursor = listed.nextCursor;
	} while (cursor);
	return mapMcpPrompts(server, prompts);
}

export function mapMcpPrompts(
	server: McpServerConfig,
	prompts: readonly SdkPrompt[],
): McpPromptDefinition[] {
	return prompts
		.filter((prompt) => isMcpPromptEnabled(prompt.name, server))
		.map((prompt) => ({
			...prompt,
			serverName: server.name,
			arguments: prompt.arguments ?? [],
		}));
}

export function isMcpPromptEnabled(
	promptName: string,
	server: Pick<McpServerConfig, "enabledPrompts" | "disabledPrompts">,
): boolean {
	if (server.enabledPrompts !== undefined) {
		return server.enabledPrompts.includes(promptName);
	}
	return !server.disabledPrompts.includes(promptName);
}

export function mcpPromptDefinitionChanged(
	current: McpPromptDefinition,
	next: McpPromptDefinition,
): boolean {
	return (
		current.description !== next.description ||
		current.title !== next.title ||
		JSON.stringify(current.icons ?? null) !==
			JSON.stringify(next.icons ?? null) ||
		JSON.stringify(current._meta ?? null) !==
			JSON.stringify(next._meta ?? null) ||
		JSON.stringify(current.arguments) !== JSON.stringify(next.arguments)
	);
}
