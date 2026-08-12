import { errorMessage } from "../../utils/errors.ts";
import {
	disableConfiguredMcpServer,
	type McpServerFileEntry,
	removeConfiguredMcpServer,
	saveProjectMcpServer,
} from "./config.ts";
import type { McpPromptResult } from "./MCPPromptDefinitions.ts";
import type { McpReadResourceResult } from "./MCPResourceDefinitions.ts";
import { expandResourceTemplate } from "./MCPResourceTemplate.ts";
import type {
	McpPromptDefinition,
	McpPromptRefreshResult,
	McpResourceDefinition,
	McpResourceRefreshResult,
	McpResourceTemplateDefinition,
	McpServerMutationResult,
	McpServerRuntimeStatus,
} from "./MCPTypes.ts";
import {
	listMcpRegistryServers,
	type McpRegistryCategory,
	type McpRegistryServer,
	parseManualMcpInput,
} from "./registry.ts";

export interface McpControllerDeps {
	cwd: string;
	listRegistryServers?: typeof listMcpRegistryServers;
	parseManualInput?: typeof parseManualMcpInput;
	saveProjectServer?: typeof saveProjectMcpServer;
	disableConfigServer?: typeof disableConfiguredMcpServer;
	removeConfigServer?: typeof removeConfiguredMcpServer;
	activateServer?: (
		name: string,
		config: McpServerFileEntry,
		signal?: AbortSignal,
	) => Promise<McpServerMutationResult>;
	authenticateServer?: (
		name: string,
		signal?: AbortSignal,
	) => Promise<McpServerMutationResult>;
	disableServer?: (name: string) => Promise<McpServerMutationResult>;
	removeServer?: (name: string) => Promise<McpServerMutationResult>;
	listServerStatuses?: () => McpServerRuntimeStatus[];
	listPrompts?: (
		serverName: string,
		signal: AbortSignal,
	) => Promise<McpPromptDefinition[]>;
	getPrompt?: (
		serverName: string,
		name: string,
		args: Record<string, string> | undefined,
		signal: AbortSignal,
	) => Promise<McpPromptResult>;
	listResources?: (
		serverName: string,
		signal: AbortSignal,
	) => Promise<McpResourceDefinition[]>;
	listResourceTemplates?: (
		serverName: string,
		signal: AbortSignal,
	) => Promise<McpResourceTemplateDefinition[]>;
	readResource?: (
		serverName: string,
		uri: string,
		signal: AbortSignal,
	) => Promise<McpReadResourceResult>;
	subscribeResource?: (
		serverName: string,
		uri: string,
		signal: AbortSignal,
	) => Promise<void>;
	unsubscribeResource?: (
		serverName: string,
		uri: string,
		signal: AbortSignal,
	) => Promise<void>;
	refreshPrompts?: (signal: AbortSignal) => Promise<McpPromptRefreshResult>;
	refreshResources?: (signal: AbortSignal) => Promise<McpResourceRefreshResult>;
}

export interface McpPrimitiveRefreshResult {
	prompts: McpPromptDefinition[];
	removedPromptNames: string[];
	resources: McpResourceDefinition[];
	removedResourceUris: string[];
	updatedResourceUris: string[];
	warnings: string[];
}

export type McpPrimitiveBrowseResult = {
	prompts: McpPromptDefinition[];
	resources: McpResourceDefinition[];
	templates: McpResourceTemplateDefinition[];
	warnings: string[];
};

export interface McpRegistryItem {
	id: string;
	title: string;
	category: McpRegistryCategory;
	description: string;
	detail: string;
	requiredEnv: string[];
	disabledReason?: string;
}

export interface McpAddResult extends McpServerMutationResult {
	name: string;
	title: string;
	requiredEnv: string[];
}

/**
 * Owns MCP manager actions used by the UI: curated server selection, manual
 * input parsing, project config writes, and source-aware server mutations.
 */
export class McpController {
	private readonly registryServers = new Map<string, McpRegistryServer>();
	private readonly listRegistryServersFn: typeof listMcpRegistryServers;
	private readonly parseManualInputFn: typeof parseManualMcpInput;
	private readonly saveProjectServerFn: typeof saveProjectMcpServer;
	private readonly disableConfigServerFn: typeof disableConfiguredMcpServer;
	private readonly removeConfigServerFn: typeof removeConfiguredMcpServer;
	private readonly activateServerFn:
		| McpControllerDeps["activateServer"]
		| undefined;
	private readonly authenticateServerFn:
		| McpControllerDeps["authenticateServer"]
		| undefined;
	private readonly disableServerFn:
		| McpControllerDeps["disableServer"]
		| undefined;
	private readonly removeServerFn:
		| McpControllerDeps["removeServer"]
		| undefined;
	private readonly listServerStatusesFn:
		| McpControllerDeps["listServerStatuses"]
		| undefined;
	private readonly listPromptsFn: McpControllerDeps["listPrompts"] | undefined;
	private readonly getPromptFn: McpControllerDeps["getPrompt"] | undefined;
	private readonly listResourcesFn:
		| McpControllerDeps["listResources"]
		| undefined;
	private readonly listResourceTemplatesFn:
		| McpControllerDeps["listResourceTemplates"]
		| undefined;
	private readonly readResourceFn:
		| McpControllerDeps["readResource"]
		| undefined;
	private readonly subscribeResourceFn:
		| McpControllerDeps["subscribeResource"]
		| undefined;
	private readonly unsubscribeResourceFn:
		| McpControllerDeps["unsubscribeResource"]
		| undefined;
	private readonly refreshPromptsFn:
		| McpControllerDeps["refreshPrompts"]
		| undefined;
	private readonly refreshResourcesFn:
		| McpControllerDeps["refreshResources"]
		| undefined;

	constructor(private readonly deps: McpControllerDeps) {
		this.listRegistryServersFn =
			deps.listRegistryServers ?? listMcpRegistryServers;
		this.parseManualInputFn = deps.parseManualInput ?? parseManualMcpInput;
		this.saveProjectServerFn = deps.saveProjectServer ?? saveProjectMcpServer;
		this.disableConfigServerFn =
			deps.disableConfigServer ?? disableConfiguredMcpServer;
		this.removeConfigServerFn =
			deps.removeConfigServer ?? removeConfiguredMcpServer;
		this.activateServerFn = deps.activateServer;
		this.authenticateServerFn = deps.authenticateServer;
		this.disableServerFn = deps.disableServer;
		this.removeServerFn = deps.removeServer;
		this.listServerStatusesFn = deps.listServerStatuses;
		this.listPromptsFn = deps.listPrompts;
		this.getPromptFn = deps.getPrompt;
		this.listResourcesFn = deps.listResources;
		this.listResourceTemplatesFn = deps.listResourceTemplates;
		this.readResourceFn = deps.readResource;
		this.subscribeResourceFn = deps.subscribeResource;
		this.unsubscribeResourceFn = deps.unsubscribeResource;
		this.refreshPromptsFn = deps.refreshPrompts;
		this.refreshResourcesFn = deps.refreshResources;
	}

	listServerStatuses(): McpServerRuntimeStatus[] {
		return this.listServerStatusesFn?.() ?? [];
	}

	async listRegistryServers(signal?: AbortSignal): Promise<McpRegistryItem[]> {
		const servers = await this.fetchRegistryServers(signal);
		this.registryServers.clear();
		for (const server of servers) {
			this.registryServers.set(server.name, server);
		}
		return servers.map(registryItemForServer);
	}

	async addRegistryServer(
		item: McpRegistryItem,
		signal?: AbortSignal,
	): Promise<McpAddResult> {
		throwIfAborted(signal);
		const server = this.registryServers.get(item.id);
		if (!server) throw new Error(`Unknown curated MCP server: ${item.title}`);
		if (server.disabledReason) throw new Error(server.disabledReason);
		return this.saveServer(server, signal);
	}

	async addManualServer(
		input: string,
		signal?: AbortSignal,
	): Promise<McpAddResult> {
		throwIfAborted(signal);
		return this.saveServer(this.parseManualInputFn(input), signal);
	}

	async authenticateServer(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpServerMutationResult> {
		throwIfAborted(signal);
		if (!this.authenticateServerFn) {
			return {
				toolNames: [],
				warnings: [`MCP authentication is not available for ${server.name}.`],
			};
		}
		return await this.authenticateServerFn(server.name, signal);
	}

	async disableServer(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpServerMutationResult> {
		throwIfAborted(signal);
		await this.disableConfigServerFn(
			this.deps.cwd,
			server.name,
			server.configSources,
		);
		throwIfAborted(signal);
		if (!this.disableServerFn) {
			return {
				toolNames: [],
				warnings: [`MCP runtime disable is not available for ${server.name}.`],
			};
		}
		return await this.disableServerFn(server.name);
	}

	async removeServer(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpServerMutationResult> {
		throwIfAborted(signal);
		await this.removeConfigServerFn(
			this.deps.cwd,
			server.name,
			server.configSources,
		);
		throwIfAborted(signal);
		if (!this.removeServerFn) {
			return {
				toolNames: [],
				warnings: [`MCP runtime remove is not available for ${server.name}.`],
			};
		}
		return await this.removeServerFn(server.name);
	}

	async listPrompts(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpPromptDefinition[]> {
		throwIfAborted(signal);
		if (!this.listPromptsFn) return [];
		return await this.listPromptsFn(server.name, requiredSignal(signal));
	}

	async browsePrimitives(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpPrimitiveBrowseResult> {
		throwIfAborted(signal);
		const controller = requiredSignal(signal);
		const [promptsResult, resourcesResult, templatesResult] =
			await Promise.allSettled([
				server.capabilities?.prompts
					? this.listPrompts(server, controller)
					: Promise.resolve([]),
				server.capabilities?.resources
					? this.listResources(server, controller)
					: Promise.resolve([]),
				server.capabilities?.resources
					? this.listResourceTemplates(server, controller)
					: Promise.resolve([]),
			]);
		const prompts =
			promptsResult.status === "fulfilled" ? promptsResult.value : [];
		const resources =
			resourcesResult.status === "fulfilled" ? resourcesResult.value : [];
		const templates =
			templatesResult.status === "fulfilled" ? templatesResult.value : [];
		const warnings = [promptsResult, resourcesResult, templatesResult]
			.filter((result) => result.status === "rejected")
			.map((result) =>
				result.status === "rejected" ? errorMessage(result.reason) : "",
			)
			.filter(Boolean);
		if (
			warnings.length > 0 &&
			prompts.length + resources.length + templates.length === 0
		) {
			throw new Error(warnings.join(" "));
		}
		return { prompts, resources, templates, warnings };
	}

	async getPrompt(
		server: McpServerRuntimeStatus,
		name: string,
		args?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpPromptResult> {
		throwIfAborted(signal);
		if (!this.getPromptFn) {
			throw new Error(`MCP prompt reads are not available for ${server.name}.`);
		}
		return await this.getPromptFn(
			server.name,
			name,
			args,
			requiredSignal(signal),
		);
	}

	async listResources(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpResourceDefinition[]> {
		throwIfAborted(signal);
		if (!this.listResourcesFn) return [];
		return await this.listResourcesFn(server.name, requiredSignal(signal));
	}

	async listResourceTemplates(
		server: McpServerRuntimeStatus,
		signal?: AbortSignal,
	): Promise<McpResourceTemplateDefinition[]> {
		throwIfAborted(signal);
		if (!this.listResourceTemplatesFn) return [];
		return await this.listResourceTemplatesFn(
			server.name,
			requiredSignal(signal),
		);
	}

	async readResource(
		server: McpServerRuntimeStatus,
		uri: string,
		signal?: AbortSignal,
	): Promise<McpReadResourceResult> {
		throwIfAborted(signal);
		if (!this.readResourceFn) {
			throw new Error(
				`MCP resource reads are not available for ${server.name}.`,
			);
		}
		return await this.readResourceFn(server.name, uri, requiredSignal(signal));
	}

	async readResourceTemplate(
		server: McpServerRuntimeStatus,
		uriTemplate: string,
		values: Record<string, string>,
		signal?: AbortSignal,
	): Promise<McpReadResourceResult> {
		return await this.readResource(
			server,
			expandResourceTemplate(uriTemplate, values),
			signal,
		);
	}

	async subscribeResource(
		server: McpServerRuntimeStatus,
		uri: string,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (!this.subscribeResourceFn) {
			throw new Error(
				`MCP resource subscriptions are not available for ${server.name}.`,
			);
		}
		await this.subscribeResourceFn(server.name, uri, requiredSignal(signal));
	}

	async unsubscribeResource(
		server: McpServerRuntimeStatus,
		uri: string,
		signal?: AbortSignal,
	): Promise<void> {
		throwIfAborted(signal);
		if (!this.unsubscribeResourceFn) {
			throw new Error(
				`MCP resource subscriptions are not available for ${server.name}.`,
			);
		}
		await this.unsubscribeResourceFn(server.name, uri, requiredSignal(signal));
	}

	async refreshPromptAndResourceUpdates(
		signal?: AbortSignal,
	): Promise<McpPrimitiveRefreshResult> {
		throwIfAborted(signal);
		const controller = requiredSignal(signal);
		const prompts: McpPromptDefinition[] = [];
		const removedPromptNames: string[] = [];
		const resources: McpResourceDefinition[] = [];
		const removedResourceUris: string[] = [];
		const updatedResourceUris: string[] = [];
		const warnings: string[] = [];
		if (this.refreshPromptsFn) {
			const result = await this.refreshPromptsFn(controller);
			prompts.push(...result.prompts);
			removedPromptNames.push(...result.removedPromptNames);
			warnings.push(...result.warnings);
		}
		if (this.refreshResourcesFn) {
			const result = await this.refreshResourcesFn(controller);
			resources.push(...result.resources);
			removedResourceUris.push(...result.removedResourceUris);
			updatedResourceUris.push(...result.updatedResourceUris);
			warnings.push(...result.warnings);
		}
		return {
			prompts,
			removedPromptNames,
			resources,
			removedResourceUris,
			updatedResourceUris,
			warnings,
		};
	}

	private async saveServer(
		server: {
			name: string;
			title: string;
			config: McpServerFileEntry;
			requiredEnv: string[];
		},
		signal?: AbortSignal,
	): Promise<McpAddResult> {
		throwIfAborted(signal);
		await this.saveProjectServerFn(this.deps.cwd, server.name, server.config);
		throwIfAborted(signal);
		const activation = this.activateServerFn
			? await this.activateServerFn(server.name, server.config, signal)
			: { toolNames: [], warnings: [] };
		throwIfAborted(signal);
		return {
			name: server.name,
			title: server.title,
			requiredEnv: [...server.requiredEnv],
			toolNames: activation.toolNames,
			warnings: activation.warnings,
		};
	}

	private async fetchRegistryServers(
		signal?: AbortSignal,
	): Promise<McpRegistryServer[]> {
		try {
			return await this.listRegistryServersFn(signal);
		} catch (err) {
			if (signal?.aborted || isAbortError(err)) throw err;
			return [];
		}
	}
}

function registryItemForServer(server: McpRegistryServer): McpRegistryItem {
	return {
		id: server.name,
		title: server.title,
		category: server.category,
		description: server.description,
		detail: server.detail,
		requiredEnv: [...server.requiredEnv],
		...(server.disabledReason ? { disabledReason: server.disabledReason } : {}),
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const err = new Error("MCP operation cancelled");
	err.name = "AbortError";
	throw err;
}

function requiredSignal(signal: AbortSignal | undefined): AbortSignal {
	return signal ?? new AbortController().signal;
}

function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}
