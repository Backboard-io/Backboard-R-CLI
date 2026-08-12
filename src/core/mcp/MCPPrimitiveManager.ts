import { errorMessage } from "../../utils/errors.ts";
import type { McpServerConfig } from "./config.ts";
import {
	listMcpServerPromptDefinitions,
	type McpPromptResult,
	mcpPromptDefinitionChanged,
} from "./MCPPromptDefinitions.ts";
import {
	isMcpResourceEnabled,
	listMcpServerResourceDefinitions,
	listMcpServerResourceTemplateDefinitions,
	type McpReadResourceResult,
	mcpResourceDefinitionChanged,
} from "./MCPResourceDefinitions.ts";
import type {
	McpConnection,
	McpPromptDefinition,
	McpPromptRefreshResult,
	McpResourceDefinition,
	McpResourceRefreshResult,
	McpResourceTemplateDefinition,
	McpServerRuntimeStatus,
} from "./MCPTypes.ts";

export interface McpPrimitiveManagerDeps {
	connections: Map<string, McpConnection>;
	serverStatuses: Map<string, McpServerRuntimeStatus>;
}

export class McpPrimitiveManager {
	private readonly dirtyPromptServers = new Set<string>();
	private readonly dirtyResourceServers = new Set<string>();

	constructor(private readonly deps: McpPrimitiveManagerDeps) {}

	markPromptListChanged(serverName: string): void {
		this.dirtyPromptServers.add(serverName);
	}

	markResourceListChanged(serverName: string): void {
		this.dirtyResourceServers.add(serverName);
	}

	markResourceUpdated(serverName: string, uri: string): void {
		this.dirtyResourceServers.add(serverName);
		const connection = this.deps.connections.get(serverName);
		connection?.updatedResourceUris.add(uri);
		const status = this.deps.serverStatuses.get(serverName);
		if (status) {
			status.updatedResourceUris = unique([
				...(status.updatedResourceUris ?? []),
				uri,
			]);
		}
	}

	clear(): void {
		this.dirtyPromptServers.clear();
		this.dirtyResourceServers.clear();
	}

	clearServer(serverName: string): void {
		this.dirtyPromptServers.delete(serverName);
		this.dirtyResourceServers.delete(serverName);
	}

	async listPrompts(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpPromptDefinition[]> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.prompts) return [];
		const prompts = await listMcpServerPromptDefinitions(
			connection.server,
			connection.client,
			signal,
		);
		connection.prompts = new Map(
			prompts.map((prompt) => [prompt.name, prompt]),
		);
		this.updateStatusPrompts(connection.server.name);
		return prompts;
	}

	async getPrompt(
		serverName: string,
		name: string,
		args: Record<string, string> | undefined,
		signal: AbortSignal,
	): Promise<McpPromptResult> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.prompts) {
			throw new Error(`MCP server '${serverName}' does not support prompts.`);
		}
		if (!isPromptEnabled(connection.server, name)) {
			throw new Error(`MCP prompt '${serverName}.${name}' is disabled.`);
		}
		return connection.client.getPrompt(
			args ? { name, arguments: args } : { name },
			{ signal, timeout: connection.server.timeoutMs },
		);
	}

	async refreshPrompts(signal: AbortSignal): Promise<McpPromptRefreshResult> {
		const prompts: McpPromptDefinition[] = [];
		const removedPromptNames: string[] = [];
		const warnings: string[] = [];
		const dirtyServers = [...this.dirtyPromptServers];
		this.dirtyPromptServers.clear();

		for (const serverName of dirtyServers) {
			const connection = this.deps.connections.get(serverName);
			if (!connection) continue;
			if (!connection.capabilities.prompts) continue;
			let latest: McpPromptDefinition[];
			try {
				latest = await listMcpServerPromptDefinitions(
					connection.server,
					connection.client,
					signal,
				);
			} catch (err) {
				warnings.push(
					`Failed to refresh MCP server '${connection.server.name}' prompts: ${errorMessage(err)}.`,
				);
				this.dirtyPromptServers.add(connection.server.name);
				continue;
			}

			const latestByName = new Map(
				latest.map((prompt) => [prompt.name, prompt]),
			);
			const changed: McpPromptDefinition[] = [];

			for (const [name, existing] of [...connection.prompts]) {
				const next = latestByName.get(name);
				if (!next) {
					connection.prompts.delete(name);
					removedPromptNames.push(`${connection.server.name}.${name}`);
					continue;
				}
				if (mcpPromptDefinitionChanged(existing, next)) {
					connection.prompts.set(name, next);
					changed.push(next);
				}
			}

			for (const prompt of latest) {
				if (!connection.prompts.has(prompt.name)) {
					connection.prompts.set(prompt.name, prompt);
					changed.push(prompt);
				}
			}
			this.updateStatusPrompts(connection.server.name);
			prompts.push(...changed);
		}

		return { prompts, removedPromptNames, warnings };
	}

	async listResources(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceDefinition[]> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.resources) return [];
		const resources = await listMcpServerResourceDefinitions(
			connection.server,
			connection.client,
			signal,
		);
		connection.resources = new Map(
			resources.map((resource) => [resource.uri, resource]),
		);
		this.updateStatusResources(connection.server.name);
		return resources;
	}

	async listResourceTemplates(
		serverName: string,
		signal: AbortSignal,
	): Promise<McpResourceTemplateDefinition[]> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.resources) return [];
		return listMcpServerResourceTemplateDefinitions(
			connection.server,
			connection.client,
			signal,
		);
	}

	async readResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<McpReadResourceResult> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.resources) {
			throw new Error(`MCP server '${serverName}' does not support resources.`);
		}
		if (!isMcpResourceEnabled(uri, connection.server)) {
			throw new Error(`MCP resource '${serverName}.${uri}' is disabled.`);
		}
		const result = await connection.client.readResource(
			{ uri },
			{ signal, timeout: connection.server.timeoutMs },
		);
		connection.updatedResourceUris.delete(uri);
		this.updateStatusResources(connection.server.name);
		return result;
	}

	async subscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.resources?.subscribe) {
			throw new Error(
				`MCP server '${serverName}' does not support resource subscriptions.`,
			);
		}
		if (!isMcpResourceEnabled(uri, connection.server)) {
			throw new Error(`MCP resource '${serverName}.${uri}' is disabled.`);
		}
		await connection.client.subscribeResource(
			{ uri },
			{ signal, timeout: connection.server.timeoutMs },
		);
		connection.subscribedResourceUris.add(uri);
		this.updateStatusResources(connection.server.name);
	}

	async unsubscribeResource(
		serverName: string,
		uri: string,
		signal: AbortSignal,
	): Promise<void> {
		const connection = this.requireConnection(serverName);
		if (!connection.capabilities.resources?.subscribe) {
			throw new Error(
				`MCP server '${serverName}' does not support resource subscriptions.`,
			);
		}
		await connection.client.unsubscribeResource(
			{ uri },
			{ signal, timeout: connection.server.timeoutMs },
		);
		connection.subscribedResourceUris.delete(uri);
		connection.updatedResourceUris.delete(uri);
		this.updateStatusResources(connection.server.name);
	}

	async refreshResources(
		signal: AbortSignal,
	): Promise<McpResourceRefreshResult> {
		const resources: McpResourceDefinition[] = [];
		const removedResourceUris: string[] = [];
		const updatedResourceUris: string[] = [];
		const warnings: string[] = [];
		const dirtyServers = [...this.dirtyResourceServers];
		this.dirtyResourceServers.clear();

		for (const serverName of dirtyServers) {
			const connection = this.deps.connections.get(serverName);
			if (!connection) continue;
			if (!connection.capabilities.resources) continue;
			const serverUpdatedResourceUris = unique([
				...connection.updatedResourceUris,
			]);
			updatedResourceUris.push(
				...serverUpdatedResourceUris.map(
					(uri) => `${connection.server.name}.${uri}`,
				),
			);

			let latest: McpResourceDefinition[];
			try {
				latest = await listMcpServerResourceDefinitions(
					connection.server,
					connection.client,
					signal,
				);
			} catch (err) {
				warnings.push(
					`Failed to refresh MCP server '${connection.server.name}' resources: ${errorMessage(err)}.`,
				);
				this.dirtyResourceServers.add(connection.server.name);
				continue;
			}

			const latestByUri = new Map(
				latest.map((resource) => [resource.uri, resource]),
			);
			const changed: McpResourceDefinition[] = [];

			for (const [uri, existing] of [...connection.resources]) {
				const next = latestByUri.get(uri);
				if (!next) {
					connection.resources.delete(uri);
					removedResourceUris.push(`${connection.server.name}.${uri}`);
					continue;
				}
				if (mcpResourceDefinitionChanged(existing, next)) {
					connection.resources.set(uri, next);
					changed.push(next);
				}
			}

			for (const resource of latest) {
				if (!connection.resources.has(resource.uri)) {
					connection.resources.set(resource.uri, resource);
					changed.push(resource);
				}
			}
			this.updateStatusResources(connection.server.name);
			resources.push(...changed);
		}

		return { resources, removedResourceUris, updatedResourceUris, warnings };
	}

	private requireConnection(serverName: string): McpConnection {
		const connection = this.deps.connections.get(serverName);
		if (!connection) {
			throw new Error(`MCP server '${serverName}' is not connected.`);
		}
		return connection;
	}

	private updateStatusPrompts(serverName: string): void {
		const connection = this.deps.connections.get(serverName);
		const status = this.deps.serverStatuses.get(serverName);
		if (!connection || !status) return;
		status.promptNames = [...connection.prompts.keys()];
	}

	private updateStatusResources(serverName: string): void {
		const connection = this.deps.connections.get(serverName);
		const status = this.deps.serverStatuses.get(serverName);
		if (!connection || !status) return;
		status.resourceUris = [...connection.resources.keys()];
		status.updatedResourceUris = [...connection.updatedResourceUris];
		status.subscribedResourceUris = [...connection.subscribedResourceUris];
	}
}

function isPromptEnabled(server: McpServerConfig, promptName: string): boolean {
	if (server.enabledPrompts !== undefined) {
		return server.enabledPrompts.includes(promptName);
	}
	return !server.disabledPrompts.includes(promptName);
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}
