import { createHash } from "node:crypto";

const MAX_FUNCTION_NAME_LENGTH = 64;
const HASH_LENGTH = 10;

export function mcpFunctionName(
	serverName: string,
	toolName: string,
	options: { hashed?: boolean } = {},
): string {
	const server = sanitizeComponent(serverName, "server");
	const tool = sanitizeComponent(toolName, "tool");
	const plain = `mcp__${server}__${tool}`;
	if (!options.hashed && plain.length <= MAX_FUNCTION_NAME_LENGTH) {
		return plain;
	}

	const hash = createHash("sha256")
		.update(serverName)
		.update("\0")
		.update(toolName)
		.digest("hex")
		.slice(0, HASH_LENGTH);
	const reserved = "mcp__".length + "__".length + "__".length + hash.length;
	const remaining = Math.max(2, MAX_FUNCTION_NAME_LENGTH - reserved);
	const serverBudget = Math.max(1, Math.floor(remaining * 0.45));
	const toolBudget = Math.max(1, remaining - serverBudget);

	return `mcp__${truncate(server, serverBudget)}__${truncate(
		tool,
		toolBudget,
	)}__${hash}`;
}

function sanitizeComponent(value: string, fallback: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, "_").toLowerCase();
	return sanitized.length > 0 ? sanitized : fallback;
}

// Deliberate hard slice with no ellipsis: results feed generated tool names,
// which must stay within the [A-Za-z0-9_-] charset.
function truncate(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(0, maxLength);
}
