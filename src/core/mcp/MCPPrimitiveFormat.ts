import type { McpPromptResult } from "./MCPPromptDefinitions.ts";
import type { McpReadResourceResult } from "./MCPResourceDefinitions.ts";

export function formatMcpPromptForUser(
	serverName: string,
	result: McpPromptResult,
): string {
	const lines = [`Use this MCP prompt from ${serverName}:`];
	if (result.description) lines.push(`Description: ${result.description}`);
	for (const message of result.messages) {
		lines.push(`[${message.role}]`, formatMcpPromptContent(message.content));
	}
	return lines.join("\n\n");
}

export function formatMcpResourceForUser(
	serverName: string,
	contents: McpReadResourceResult["contents"],
): string {
	return [
		`Use this MCP resource content from ${serverName}:`,
		...contents.map(formatMcpResourceContent),
	].join("\n\n");
}

function formatMcpPromptContent(content: unknown): string {
	if (!isRecord(content)) return JSON.stringify(content);
	if (content.type === "text" && typeof content.text === "string") {
		return content.text;
	}
	if (content.type === "resource" && isRecord(content.resource)) {
		return formatMcpResourceContent(content.resource);
	}
	return JSON.stringify(content, null, 2);
}

function formatMcpResourceContent(content: unknown): string {
	if (!isRecord(content)) return JSON.stringify(content);
	const uri = typeof content.uri === "string" ? content.uri : "unknown";
	const mimeType =
		typeof content.mimeType === "string" ? ` (${content.mimeType})` : "";
	if (typeof content.text === "string") {
		return `Resource ${uri}${mimeType}:\n${content.text}`;
	}
	if (typeof content.blob === "string") {
		return `Resource ${uri}${mimeType}: [${content.blob.length} base64 characters]`;
	}
	return JSON.stringify(content, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
