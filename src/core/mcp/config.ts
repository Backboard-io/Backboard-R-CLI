import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadRuntimeEnv, type RuntimeEnv } from "../../config/env.ts";
import {
	type McpConfigPaths,
	qProjectMcpConfigPath,
	qUserMcpConfigPath,
} from "../../config/paths.ts";
import { errorMessage } from "../../utils/errors.ts";

export const DEFAULT_MCP_TIMEOUT_MS = 60_000;

const ServerSchema = z
	.object({
		type: z.enum(["stdio", "http", "streamable-http", "sse"]).optional(),
		disabled: z.boolean().optional(),
		command: z.string().optional(),
		args: z.array(z.string()).optional(),
		env: z.record(z.string()).optional(),
		cwd: z.string().optional(),
		url: z.string().optional(),
		headers: z.record(z.string()).optional(),
		enabledTools: z.array(z.string()).optional(),
		disabledTools: z.array(z.string()).optional(),
		enabledPrompts: z.array(z.string()).optional(),
		disabledPrompts: z.array(z.string()).optional(),
		enabledResources: z.array(z.string()).optional(),
		disabledResources: z.array(z.string()).optional(),
		timeoutMs: z.number().int().positive().optional(),
		trustToolAnnotations: z.boolean().optional(),
	})
	.passthrough();

const FileSchema = z
	.object({
		timeoutMs: z.number().int().positive().optional(),
		mcpServers: z.record(ServerSchema).optional(),
	})
	.passthrough();

type RawServer = z.infer<typeof ServerSchema>;
type RawFile = z.infer<typeof FileSchema>;

export type McpServerTransport = "stdio" | "http";
export type McpConfigSourceScope = "project" | "user";
export type { McpConfigPaths } from "../../config/paths.ts";

export interface McpConfigSource {
	scope: McpConfigSourceScope;
	path: string;
}

export interface McpServerFileEntry {
	type?: "stdio" | "http" | "streamable-http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabledTools?: string[];
	disabledTools?: string[];
	enabledPrompts?: string[];
	disabledPrompts?: string[];
	enabledResources?: string[];
	disabledResources?: string[];
	timeoutMs?: number;
	trustToolAnnotations?: boolean;
}

export interface McpServerConfig {
	name: string;
	type: McpServerTransport;
	disabled: boolean;
	configSources: McpConfigSource[];
	command?: string;
	args: string[];
	env: Record<string, string>;
	cwd?: string;
	url?: string;
	headers: Record<string, string>;
	enabledTools?: string[];
	disabledTools: string[];
	enabledPrompts?: string[];
	disabledPrompts: string[];
	enabledResources?: string[];
	disabledResources: string[];
	timeoutMs: number;
	trustToolAnnotations: boolean;
}

export interface McpConfig {
	timeoutMs: number;
	servers: McpServerConfig[];
	warnings: string[];
}

export interface LoadMcpConfigOptions {
	cwd: string;
	homeDir?: string;
	env?: RuntimeEnv;
	paths?: McpConfigPaths;
}

interface LoadedFile {
	data: RawFile;
	source: McpConfigSource;
}

interface LayeredServer {
	raw: RawServer;
	sources: McpConfigSource[];
}

export async function loadMcpConfig(
	options: LoadMcpConfigOptions,
): Promise<McpConfig> {
	const cwd = path.resolve(options.cwd);
	const paths = options.paths ?? mcpConfigPaths(cwd, options.homeDir);
	const warnings: string[] = [];
	const files = await loadFiles(
		[
			{ scope: "project", path: paths.project },
			{ scope: "user", path: paths.user },
		],
		warnings,
	);
	let timeoutMs = DEFAULT_MCP_TIMEOUT_MS;
	const layeredServers = new Map<string, LayeredServer>();

	for (const file of files) {
		if (file.data.timeoutMs !== undefined) {
			timeoutMs = file.data.timeoutMs;
		}
		const servers = file.data.mcpServers ?? {};
		for (const [name, entry] of Object.entries(servers)) {
			const raw = scopedServer(name, entry, file.source, warnings);
			const existing = layeredServers.get(name);
			layeredServers.set(name, {
				raw: existing ? mergeServer(existing.raw, raw) : raw,
				sources: [...(existing?.sources ?? []), file.source],
			});
		}
	}

	const env = options.env ?? loadRuntimeEnv();
	const servers: McpServerConfig[] = [];
	for (const [name, layered] of layeredServers) {
		const server = normalizeServer(
			name,
			layered.raw,
			timeoutMs,
			env,
			warnings,
			layered.sources,
		);
		if (server) servers.push(server);
	}

	return { timeoutMs, servers, warnings };
}

export function normalizeMcpServer(
	name: string,
	server: McpServerFileEntry,
	options: {
		timeoutMs?: number;
		env?: RuntimeEnv;
		warnings?: string[];
		configSources?: McpConfigSource[];
	} = {},
): McpServerConfig | null {
	return normalizeServer(
		name,
		server as RawServer,
		options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
		options.env ?? loadRuntimeEnv(),
		options.warnings ?? [],
		options.configSources ?? [],
	);
}

export function mcpConfigPaths(cwd: string, homeDir?: string): McpConfigPaths {
	return {
		project: mcpProjectConfigPath(cwd),
		user: qUserMcpConfigPath(homeDir),
	};
}

export function mcpProjectConfigPath(cwd: string): string {
	return qProjectMcpConfigPath(cwd);
}

export async function saveProjectMcpServer(
	cwd: string,
	name: string,
	server: McpServerFileEntry,
): Promise<string> {
	const filePath = mcpProjectConfigPath(cwd);
	const data = await readMcpFile(filePath);
	const existingServers = isRecord(data.mcpServers) ? data.mcpServers : {};
	if (Object.hasOwn(existingServers, name)) {
		throw new Error(`MCP server '${name}' already exists in project config.`);
	}
	data.mcpServers = {
		...existingServers,
		[name]: server,
	};

	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
	return filePath;
}

export async function disableProjectMcpServer(
	cwd: string,
	name: string,
): Promise<string> {
	return disableMcpServerInFile(mcpProjectConfigPath(cwd), name);
}

export async function disableConfiguredMcpServer(
	cwd: string,
	name: string,
	sources: readonly McpConfigSource[] = [],
): Promise<string> {
	const target = highestPrecedenceSource(cwd, sources);
	return disableMcpServerInFile(target.path, name);
}

async function disableMcpServerInFile(
	filePath: string,
	name: string,
): Promise<string> {
	const data = await readMcpFile(filePath);
	const existingServers = isRecord(data.mcpServers) ? data.mcpServers : {};
	const existingServer = existingServers[name];
	if (existingServer !== undefined && !isRecord(existingServer)) {
		throw new Error(`MCP server '${name}' in MCP config must be an object.`);
	}
	data.mcpServers = {
		...existingServers,
		[name]: {
			...(existingServer ?? {}),
			disabled: true,
		},
	};

	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
	return filePath;
}

export async function removeProjectMcpServer(
	cwd: string,
	name: string,
): Promise<string> {
	const filePath = mcpProjectConfigPath(cwd);
	const removed = await removeMcpServerFromFile(filePath, name);
	if (!removed) {
		throw new Error(`MCP server '${name}' is not in project config.`);
	}
	return filePath;
}

export async function removeConfiguredMcpServer(
	cwd: string,
	name: string,
	sources: readonly McpConfigSource[] = [],
): Promise<string[]> {
	const targets =
		sources.length > 0
			? sources
			: [
					{
						scope: "project",
						path: mcpProjectConfigPath(cwd),
					} satisfies McpConfigSource,
				];
	const removedPaths: string[] = [];
	for (const source of targets) {
		if (await removeMcpServerFromFile(source.path, name)) {
			removedPaths.push(source.path);
		}
	}
	if (removedPaths.length === 0) {
		throw new Error(`MCP server '${name}' is not in MCP config.`);
	}
	return removedPaths;
}

async function removeMcpServerFromFile(
	filePath: string,
	name: string,
): Promise<boolean> {
	const data = await readMcpFile(filePath);
	const existingServers = isRecord(data.mcpServers) ? data.mcpServers : {};
	if (!Object.hasOwn(existingServers, name)) {
		return false;
	}
	const nextServers = { ...existingServers };
	delete nextServers[name];
	data.mcpServers = nextServers;

	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
	return true;
}

async function loadFiles(
	sources: readonly McpConfigSource[],
	warnings: string[],
): Promise<LoadedFile[]> {
	const files: LoadedFile[] = [];
	for (const source of sources) {
		const filePath = source.path;
		if (!existsSync(filePath)) continue;
		try {
			const content = await readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as unknown;
			const result = FileSchema.safeParse(parsed);
			if (!result.success) {
				warnings.push(`Skipped MCP config ${filePath}: invalid schema.`);
				continue;
			}
			files.push({ data: result.data, source });
		} catch (err) {
			warnings.push(`Skipped MCP config ${filePath}: ${errorMessage(err)}.`);
		}
	}
	return files;
}

function scopedServer(
	name: string,
	raw: RawServer,
	source: McpConfigSource,
	warnings: string[],
): RawServer {
	if (source.scope !== "project" || raw.trustToolAnnotations === undefined) {
		return raw;
	}
	warnings.push(
		`Ignored trustToolAnnotations for MCP server '${name}' in ${source.path}: it is only honored in user config.`,
	);
	const { trustToolAnnotations: _ignored, ...rest } = raw;
	return rest;
}

function mergeServer(base: RawServer, override: RawServer): RawServer {
	return {
		...base,
		...override,
		env: mergeRecord(base.env, override.env),
		headers: mergeRecord(base.headers, override.headers),
	};
}

function mergeRecord(
	base: Record<string, string> | undefined,
	override: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!base && !override) return undefined;
	return { ...(base ?? {}), ...(override ?? {}) };
}

function normalizeServer(
	name: string,
	raw: RawServer,
	globalTimeoutMs: number,
	env: RuntimeEnv,
	warnings: string[],
	sources: readonly McpConfigSource[],
): McpServerConfig | null {
	const disabled = raw.disabled === true;
	const inferredType = inferType(raw);
	if (!inferredType) {
		if (!disabled) {
			warnings.push(
				`Skipped MCP server '${name}': expected a stdio command or HTTP url.`,
			);
		}
		return null;
	}
	if (inferredType === "sse") {
		if (!disabled) {
			warnings.push(
				`Skipped MCP server '${name}': SSE transport is not supported in MCP v1.`,
			);
		}
		return null;
	}

	const timeoutMs = raw.timeoutMs ?? globalTimeoutMs;
	const args = expandArray(raw.args ?? [], env, warnings, `${name}.args`);
	const serverEnv = expandRecord(raw.env ?? {}, env, warnings, `${name}.env`);
	const headers = expandRecord(
		raw.headers ?? {},
		env,
		warnings,
		`${name}.headers`,
	);

	if (inferredType === "stdio") {
		if (!raw.command) {
			if (!disabled) {
				warnings.push(`Skipped MCP server '${name}': missing command.`);
			}
			return null;
		}
		return {
			name,
			type: "stdio",
			disabled,
			configSources: copySources(sources),
			command: expandString(raw.command, env, warnings, `${name}.command`),
			args,
			env: serverEnv,
			cwd: raw.cwd,
			headers: {},
			enabledTools: raw.enabledTools,
			disabledTools: raw.disabledTools ?? [],
			enabledPrompts: raw.enabledPrompts,
			disabledPrompts: raw.disabledPrompts ?? [],
			enabledResources: raw.enabledResources,
			disabledResources: raw.disabledResources ?? [],
			timeoutMs,
			trustToolAnnotations: raw.trustToolAnnotations === true,
		};
	}

	if (!raw.url) {
		if (!disabled) {
			warnings.push(`Skipped MCP server '${name}': missing url.`);
		}
		return null;
	}
	return {
		name,
		type: "http",
		disabled,
		configSources: copySources(sources),
		args: [],
		env: {},
		url: expandString(raw.url, env, warnings, `${name}.url`),
		headers,
		enabledTools: raw.enabledTools,
		disabledTools: raw.disabledTools ?? [],
		enabledPrompts: raw.enabledPrompts,
		disabledPrompts: raw.disabledPrompts ?? [],
		enabledResources: raw.enabledResources,
		disabledResources: raw.disabledResources ?? [],
		timeoutMs,
		trustToolAnnotations: raw.trustToolAnnotations === true,
	};
}

function highestPrecedenceSource(
	cwd: string,
	sources: readonly McpConfigSource[],
): McpConfigSource {
	return (
		sources[sources.length - 1] ?? {
			scope: "project",
			path: mcpProjectConfigPath(cwd),
		}
	);
}

function copySources(sources: readonly McpConfigSource[]): McpConfigSource[] {
	return sources.map((source) => ({ ...source }));
}

function inferType(raw: RawServer): "stdio" | "http" | "sse" | null {
	if (raw.type === "streamable-http") return "http";
	if (raw.type === "http" || raw.type === "stdio" || raw.type === "sse") {
		return raw.type;
	}
	if (raw.command) return "stdio";
	if (raw.url) return "http";
	return null;
}

function expandArray(
	values: string[],
	env: RuntimeEnv,
	warnings: string[],
	fieldPath: string,
): string[] {
	return values.map((value, index) =>
		expandString(value, env, warnings, `${fieldPath}[${index}]`),
	);
}

function expandRecord(
	record: Record<string, string>,
	env: RuntimeEnv,
	warnings: string[],
	fieldPath: string,
): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const [key, value] of Object.entries(record)) {
		expanded[key] = expandString(value, env, warnings, `${fieldPath}.${key}`);
	}
	return expanded;
}

function expandString(
	value: string,
	env: RuntimeEnv,
	warnings: string[],
	fieldPath: string,
): string {
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
		(
			match,
			name: string,
			_defaultExpr: string | undefined,
			fallback: string,
		) => {
			const resolved = env[name];
			if (resolved !== undefined) return resolved;
			if (fallback !== undefined) return fallback;
			warnings.push(
				`MCP config ${fieldPath} references unset environment variable '${name}'.`,
			);
			return match;
		},
	);
}

async function readMcpFile(filePath: string): Promise<Record<string, unknown>> {
	if (!existsSync(filePath)) return {};
	const content = await readFile(filePath, "utf8");
	const parsed = JSON.parse(content) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`MCP config ${filePath} must be a JSON object.`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
