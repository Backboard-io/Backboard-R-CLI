import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
	Resource as SdkResource,
	ResourceTemplate as SdkResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "./config.ts";
import type {
	McpResourceDefinition,
	McpResourceTemplateDefinition,
} from "./MCPTypes.ts";

type McpListResourcesResult = Awaited<ReturnType<Client["listResources"]>>;
type McpListResourceTemplatesResult = Awaited<
	ReturnType<Client["listResourceTemplates"]>
>;
export type McpReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;

export async function listMcpServerResourceDefinitions(
	server: McpServerConfig,
	client: Client,
	signal: AbortSignal,
): Promise<McpResourceDefinition[]> {
	const resources: SdkResource[] = [];
	let cursor: string | undefined;
	do {
		const listed: McpListResourcesResult = await client.listResources(
			cursor ? { cursor } : {},
			{ signal, timeout: server.timeoutMs },
		);
		resources.push(...listed.resources);
		cursor = listed.nextCursor;
	} while (cursor);
	return mapMcpResources(server, resources);
}

export async function listMcpServerResourceTemplateDefinitions(
	server: McpServerConfig,
	client: Client,
	signal: AbortSignal,
): Promise<McpResourceTemplateDefinition[]> {
	const templates: SdkResourceTemplate[] = [];
	let cursor: string | undefined;
	do {
		const listed: McpListResourceTemplatesResult =
			await client.listResourceTemplates(cursor ? { cursor } : {}, {
				signal,
				timeout: server.timeoutMs,
			});
		templates.push(...listed.resourceTemplates);
		cursor = listed.nextCursor;
	} while (cursor);
	return mapMcpResourceTemplates(server, templates);
}

export function mapMcpResources(
	server: McpServerConfig,
	resources: readonly SdkResource[],
): McpResourceDefinition[] {
	return resources
		.filter((resource) => isMcpResourceEnabled(resource.uri, server))
		.map((resource) => ({
			...resource,
			serverName: server.name,
		}));
}

export function mapMcpResourceTemplates(
	server: McpServerConfig,
	templates: readonly SdkResourceTemplate[],
): McpResourceTemplateDefinition[] {
	return templates
		.filter((template) => isMcpResourceEnabled(template.uriTemplate, server))
		.map((template) => ({
			...template,
			serverName: server.name,
		}));
}

export function isMcpResourceEnabled(
	resourceUri: string,
	server: Pick<McpServerConfig, "enabledResources" | "disabledResources">,
): boolean {
	if (server.enabledResources !== undefined) {
		return server.enabledResources.includes(resourceUri);
	}
	return !server.disabledResources.includes(resourceUri);
}

export function mcpResourceDefinitionChanged(
	current: McpResourceDefinition,
	next: McpResourceDefinition,
): boolean {
	return (
		current.name !== next.name ||
		current.title !== next.title ||
		current.description !== next.description ||
		current.mimeType !== next.mimeType ||
		current.size !== next.size ||
		JSON.stringify(current.annotations ?? null) !==
			JSON.stringify(next.annotations ?? null) ||
		JSON.stringify(current.icons ?? null) !==
			JSON.stringify(next.icons ?? null) ||
		JSON.stringify(current._meta ?? null) !== JSON.stringify(next._meta ?? null)
	);
}
