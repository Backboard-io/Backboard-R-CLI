import { errorMessage } from "../../utils/errors.ts";
import {
	type McpConfig,
	type McpServerConfig,
	type McpServerFileEntry,
	mcpProjectConfigPath,
	normalizeMcpServer,
} from "./config.ts";
import { MCP_CLOSE_TIMEOUT_MS } from "./constants.ts";
import { McpPrimitiveManager } from "./MCPPrimitiveManager.ts";
import type { McpPromptResult } from "./MCPPromptDefinitions.ts";
import type { McpReadResourceResult } from "./MCPResourceDefinitions.ts";
import {
	type McpConnectResult,
	McpServerConnector,
} from "./MCPServerConnector.ts";
import {
	listMcpServerToolDefinitions,
	mcpToolDefinitionChanged,
	uniqueMcpRegisteredName,
} from "./MCPToolDefinitions.ts";
import type {
	McpClientTransport,
	McpConnection,
	McpInitializeResult,
	McpListedToolDefinition,
	McpPromptDefinition,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpServerMutationResult,
	McpServerRuntimeStatus,
	McpToolDefinition,
	McpToolRefreshResult,
} from "./MCPTypes.ts";

export class McpClientManager {
	private readonly connections = new Map<string, McpConnection>();
	private readonly registeredToolNames = new Set<string>();
	private readonly serverConfigs = new Map<string, McpServerConfig>();
	private readonly serverStatuses = new Map<string, McpServerRuntimeStatus>();
	private readonly dirtyToolServers = new Set<string>();
	private readonly primitives: McpPrimitiveManager;
	private readonly connector: McpServerConnector;

	constructor(
		private readonly config: McpConfig,
		private readonly cwd: string,
		private readonly closeTimeoutMs = MCP_CLOSE_TIMEOUT_MS,
	) {
		this.primitives = new McpPrimitiveManager({
			connections: this.connections,
			serverStatuses: this.serverStatuses,
		});
		this.connector = new McpServerConnector({
			cwd,
			onToolListChanged: (serverName) => this.dirtyToolServers.add(serverName),
			onPromptListChanged: (serverName) =>
				this.primitives.markPromptListChanged(serverName),
			onResourceListChanged: (serverName) =>
				this.primitives.markResourceListChanged(serverName),
			onResourceUpdated: (serverName, uri) =>
				this.primitives.markResourceUpdated(serverName, uri),
		});
		for (const server of config.servers) {
			this.serverConfigs.set(server.name, server);
			this.serverStatuses.set(server.name, {
				name: server.name,
				type: server.type,
				configSources: [...server.configSources],
				status: server.disabled ? "disabled" : "error",
				message: server.disabled ? "Server is disabled." : "Not connected.",
				toolNames: [],
				capabilities: {},
				promptNames: [],
				resourceUris: [],
				updatedResourceUris: [],
				subscribedResourceUris: [],
			});
		}
	}

	async initialize(signal: AbortSignal): Promise<McpInitializeResult> {
		this.registeredToolNames.clear();
		this.connections.clear();
		this.dirtyToolServers.clear();
		this.primitives.clear();
		const activeServers = this.config.servers.filter(
			(server) => !server.disabled,
		);
		const results = await Promise.all(
			activeServers.map((server) =>
				this.connector.connect(server, signal, { interactiveAuth: false }),
			),
		);
		const warnings = [...this.config.warnings];
		const tools: McpToolDefinition[] = [];
		const seenToolNames = new Set<string>();

		for (const result of results) {
			warnings.push(...result.warnings);
			this.applyConnectResult(result);
			tools.push(
				...this.withRegisteredNames(result.tools, seenToolNames, warnings),
			);
		}

		return { tools, warnings };
	}

	async addServer(
		name: string,
		entry: McpServerFileEntry,
		signal: AbortSignal,
	): Promise<McpInitializeResult> {
		if (this.connections.has(name)) {
			return {
				tools: [],
				warnings: [`Skipped MCP server '${name}': already connected.`],
			};
		}

		const warnings: string[] = [];
		const server = normalizeMcpServer(name, entry, {
			timeoutMs: this.config.timeoutMs,
			warnings,
			configSources: [
				{ scope: "project", path: mcpProjectConfigPath(this.cwd) },
			],
		});
		if (!server) return { tools: [], warnings };
		this.serverConfigs.set(server.name, server);
		if (server.disabled) {
			this.serverStatuses.set(server.name, {
				name: server.name,
				type: server.type,
				configSources: [...server.configSources],
				status: "disabled",
				message: "Server is disabled.",
				toolNames: [],
				capabilities: {},
				promptNames: [],
				resourceUris: [],
				updatedResourceUris: [],
				subscribedResourceUris: [],
			});
			return {
				tools: [],
				warnings: [`Skipped MCP server '${name}': server is disabled.`],
			};
		}

		const result = await this.connector.connect(server, signal, {
			interactiveAuth: false,
		});
		warnings.push(...result.warnings);
		this.applyConnectResult(result);
		return {
			tools: this.withRegisteredNames(
				result.tools,
				this.registeredToolNames,
				warnings,
			),
			warnings,
		};
	}

	async authenticateServer(
		name: string,
		signal: AbortSignal,
	): Promise<McpInitializeResult> {
		const server = this.serverConfigs.get(name);
		if (!server) {
			return {
				tools: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}
		if (this.connections.has(name)) await this.closeServerConnection(name);

		const result = await this.connector.connect(server, signal, {
			interactiveAuth: true,
		});
		this.applyConnectResult(result);
		return {
			tools: this.withRegisteredNames(
				result.tools,
				this.registeredToolNames,
				result.warnings,
			),
			warnings: result.warnings,
		};
	}

	async disableServer(name: string): Promise<McpServerMutationResult> {
		const server = this.serverConfigs.get(name);
		const status = this.serverStatuses.get(name);
		if (!server && !status) {
			return {
				toolNames: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}

		const toolNames = await this.closeServerConnection(name);
		if (server) {
			this.serverConfigs.set(name, { ...server, disabled: true });
		}
		this.serverStatuses.set(name, {
			name,
			type: (server ?? status)?.type ?? "stdio",
			configSources: [...((server ?? status)?.configSources ?? [])],
			status: "disabled",
			message: "Server is disabled.",
			toolNames: [],
			capabilities: {},
			promptNames: [],
			resourceUris: [],
			updatedResourceUris: [],
			subscribedResourceUris: [],
		});
		return { toolNames, warnings: [] };
	}

	async removeServer(name: string): Promise<McpServerMutationResult> {
		if (!this.serverConfigs.has(name) && !this.serverStatuses.has(name)) {
			return {
				toolNames: [],
				warnings: [`Unknown MCP server '${name}'.`],
			};
		}

		const toolNames = await this.closeServerConnection(name);
		this.serverConfigs.delete(name);
		this.serverStatuses.delete(name);
		return { toolNames, warnings: [] };
	}

	async refreshTools(signal: AbortSignal): Promise<McpToolRefreshResult> {
		const tools: McpToolDefinition[] = [];
		const removedToolNames: string[] = [];
		const warnings: string[] = [];
		const dirtyServers = [...this.dirtyToolServers];
		this.dirtyToolServers.clear();

		for (const serverName of dirtyServers) {
			const connection = this.connections.get(serverName);
			if (!connection) continue;
			let latest: McpListedToolDefinition[];
			try {
				latest = await listMcpServerToolDefinitions(
					connection.server,
					connection.client,
					signal,
				);
			} catch (err) {
				warnings.push(
					`Failed to refresh MCP server '${connection.server.name}': ${errorMessage(err)}.`,
				);
				this.dirtyToolServers.add(connection.server.name);
				continue;
			}

			const latestByToolName = new Map(
				latest.map((tool) => [tool.toolName, tool]),
			);
			const changed: McpListedToolDefinition[] = [];
			const changedToolNames = new Set<string>();

			for (const [toolName, existing] of [...connection.tools]) {
				const next = latestByToolName.get(toolName);
				if (!next || mcpToolDefinitionChanged(existing, next)) {
					const removed = this.unregisterConnectionTool(connection, toolName);
					if (removed) removedToolNames.push(removed);
				}
				if (next && mcpToolDefinitionChanged(existing, next)) {
					changed.push(next);
					changedToolNames.add(toolName);
				}
			}

			for (const tool of latest) {
				if (
					!connection.tools.has(tool.toolName) &&
					!changedToolNames.has(tool.toolName)
				) {
					changed.push(tool);
				}
			}

			tools.push(
				...this.withRegisteredNames(
					changed,
					this.registeredToolNames,
					warnings,
				),
			);
		}

		return {
			tools,
			removedToolNames,
			warnings,
		};
	}

	listPrompts(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpPromptDefinition[]> {
		return this.primitives.listPrompts(serverName, signal);
	}

	getPrompt(
		serverName: string,
		name: string,
		args: Record<string, string> | undefined,
		signal: AbortSignal,
	): Promise<McpPromptResult> {
		return this.primitives.getPrompt(serverName, name, args, signal);
	}

	refreshPrompts(signal: AbortSignal) {
		return this.primitives.refreshPrompts(signal);
	}

	listResources(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceDefinition[]> {
		return this.primitives.listResources(serverName, signal);
	}

	listResourceTemplates(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceTemplateDefinition[]> {
		return this.primitives.listResourceTemplates(serverName, signal);
	}

	readResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<McpReadResourceResult> {
		return this.primitives.readResource(serverName, uri, signal);
	}

	subscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		return this.primitives.subscribeResource(serverName, uri, signal);
	}

	unsubscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		return this.primitives.unsubscribeResource(serverName, uri, signal);
	}

	refreshResources(signal: AbortSignal) {
		return this.primitives.refreshResources(signal);
	}

	listServerStatuses(): McpServerRuntimeStatus[] {
		return [...this.serverStatuses.values()].map((status) => ({
			...status,
			configSources: status.configSources.map((source) => ({ ...source })),
			toolNames: [...status.toolNames],
			capabilities: { ...(status.capabilities ?? {}) },
			promptNames: [...(status.promptNames ?? [])],
			resourceUris: [...(status.resourceUris ?? [])],
			updatedResourceUris: [...(status.updatedResourceUris ?? [])],
			subscribedResourceUris: [...(status.subscribedResourceUris ?? [])],
		}));
	}

	async close(): Promise<void> {
		const connections = [...this.connections.values()];
		this.connections.clear();
		this.registeredToolNames.clear();
		this.dirtyToolServers.clear();
		this.primitives.clear();
		await Promise.allSettled(
			connections.map(async ({ transport }) => {
				await closeTransport(transport, this.closeTimeoutMs);
			}),
		);
	}

	private async closeServerConnection(name: string): Promise<string[]> {
		const status = this.serverStatuses.get(name);
		const toolNames = [...(status?.toolNames ?? [])];
		for (const toolName of toolNames) {
			this.registeredToolNames.delete(toolName);
		}
		const connection = this.connections.get(name);
		if (connection) {
			this.connections.delete(name);
			this.dirtyToolServers.delete(name);
			this.primitives.clearServer(name);
			await connection.transport.close().catch(() => undefined);
		}
		return toolNames;
	}

	private unregisterConnectionTool(
		connection: McpConnection,
		toolName: string,
	): string {
		const existing = connection.tools.get(toolName);
		if (!existing) return "";
		connection.tools.delete(toolName);
		this.registeredToolNames.delete(existing.registeredName);
		const status = this.serverStatuses.get(connection.server.name);
		if (status) {
			status.toolNames = status.toolNames.filter(
				(name) => name !== existing.registeredName,
			);
		}
		return existing.registeredName;
	}

	private applyConnectResult(result: McpConnectResult): void {
		this.serverStatuses.set(result.status.name, result.status);
		if (result.connection) {
			this.connections.set(result.connection.server.name, result.connection);
		}
	}

	private withRegisteredNames(
		tools: readonly McpListedToolDefinition[],
		seenToolNames: Set<string>,
		warnings: string[],
	): McpToolDefinition[] {
		const registered: McpToolDefinition[] = [];
		for (const tool of tools) {
			const registeredName = uniqueMcpRegisteredName(
				tool.serverName,
				tool.toolName,
				seenToolNames,
				warnings,
			);
			if (!registeredName) continue;
			seenToolNames.add(registeredName);
			this.registeredToolNames.add(registeredName);
			const definition = { ...tool, registeredName };
			registered.push(definition);
			this.connections
				.get(tool.serverName)
				?.tools.set(tool.toolName, definition);
			const status = this.serverStatuses.get(tool.serverName);
			if (status?.status === "connected") {
				status.toolNames.push(registeredName);
			}
		}
		return registered;
	}
}

async function closeTransport(
	transport: McpClientTransport,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			transport.close(),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
