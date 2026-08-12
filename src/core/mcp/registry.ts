import { CURATED_MCP_SERVERS, type McpCatalogServer } from "./catalog.ts";
import type { McpServerFileEntry } from "./config.ts";

export type { McpRegistryCategory } from "./catalog.ts";
export type McpRegistryServer = McpCatalogServer;

export async function listMcpRegistryServers(
	signal?: AbortSignal,
): Promise<McpRegistryServer[]> {
	throwIfAborted(signal);
	return CURATED_MCP_SERVERS.map(copyServer);
}

export function parseManualMcpInput(input: string): McpRegistryServer {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Enter an MCP server URL or command.");

	const { name, target } = splitManualName(trimmed);
	const config =
		target.startsWith("http://") || target.startsWith("https://")
			? ({ type: "http", url: target } satisfies McpServerFileEntry)
			: manualCommandConfig(target);
	const serverName = name ?? deriveManualName(target);

	return {
		name: serverName,
		title: serverName,
		category: "Additional Stdio Servers",
		description: describeConfig(config),
		detail: target,
		config,
		requiredEnv: [],
	};
}

function copyServer(server: McpRegistryServer): McpRegistryServer {
	return {
		...server,
		config: copyConfig(server.config),
		requiredEnv: [...server.requiredEnv],
	};
}

function copyConfig(config: McpServerFileEntry): McpServerFileEntry {
	return {
		...(config.type ? { type: config.type } : {}),
		...(config.command ? { command: config.command } : {}),
		...(config.args ? { args: [...config.args] } : {}),
		...(config.env ? { env: { ...config.env } } : {}),
		...(config.cwd ? { cwd: config.cwd } : {}),
		...(config.url ? { url: config.url } : {}),
		...(config.headers ? { headers: { ...config.headers } } : {}),
		...(config.enabledTools ? { enabledTools: [...config.enabledTools] } : {}),
		...(config.disabledTools
			? { disabledTools: [...config.disabledTools] }
			: {}),
		...(config.enabledPrompts
			? { enabledPrompts: [...config.enabledPrompts] }
			: {}),
		...(config.disabledPrompts
			? { disabledPrompts: [...config.disabledPrompts] }
			: {}),
		...(config.enabledResources
			? { enabledResources: [...config.enabledResources] }
			: {}),
		...(config.disabledResources
			? { disabledResources: [...config.disabledResources] }
			: {}),
		...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
	};
}

function manualCommandConfig(input: string): McpServerFileEntry {
	const parts = splitCommand(input);
	const command = parts[0];
	if (!command) throw new Error("Enter an MCP server URL or command.");
	return { command, args: parts.slice(1) };
}

function splitManualName(input: string): { name?: string; target: string } {
	const firstSpace = input.search(/\s/);
	const equalsIndex = input.indexOf("=");
	if (equalsIndex <= 0 || (firstSpace >= 0 && equalsIndex > firstSpace)) {
		return { target: input };
	}
	const rawName = input.slice(0, equalsIndex).trim();
	const target = input.slice(equalsIndex + 1).trim();
	if (!target) throw new Error("Enter an MCP server URL or command.");
	return { name: sanitizeConfigName(rawName), target };
}

function splitCommand(input: string): string[] {
	const parts: string[] = [];
	for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|[^\s]+/g)) {
		parts.push(match[1] ?? match[2] ?? match[0]);
	}
	return parts;
}

function deriveManualName(target: string): string {
	if (target.startsWith("http://") || target.startsWith("https://")) {
		return sanitizeConfigName(urlHost(target));
	}
	const parts = splitCommand(target);
	const launcher = parts[0] ?? "";
	const packageLike = ["npx", "bunx", "uvx"].includes(launcher)
		? parts.slice(1).find((part) => !part.startsWith("-"))
		: undefined;
	const fallback = packageLike ?? parts[0] ?? "mcp-server";
	return sanitizeConfigName(packageBaseName(fallback));
}

function describeConfig(config: McpServerFileEntry): string {
	if (config.url) return config.url;
	return [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
}

function packageBaseName(value: string): string {
	const withoutVersion = value.startsWith("@")
		? value.replace(/@[^/@]+$/, "")
		: value.replace(/@[^@]+$/, "");
	const parts = withoutVersion.split("/");
	return parts[parts.length - 1] ?? withoutVersion;
}

function sanitizeConfigName(value: string): string {
	const sanitized = value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/[^a-z0-9._/-]+/g, "-")
		.replace(/[./]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return sanitized || "mcp-server";
}

function urlHost(value: string): string {
	try {
		return new URL(value).hostname;
	} catch {
		return value;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const err = new Error("MCP operation cancelled");
	err.name = "AbortError";
	throw err;
}
