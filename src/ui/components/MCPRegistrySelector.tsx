import type React from "react";
import type { McpRegistryItem } from "../../core/mcp/index.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

interface Props {
	servers: McpRegistryItem[];
	onSelect: (
		server: McpRegistryItem,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function McpRegistrySelector({
	servers,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title={`MCP Catalog (${servers.length} available)`}
			tabs={registryTabs(servers)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No curated MCP servers available."
			selectingLabel="Adding MCP server"
		/>
	);
}

function registryTabs(
	servers: readonly McpRegistryItem[],
): PickerTab<McpRegistryItem>[] {
	return [
		{
			id: "catalog",
			label: "Catalog",
			items: servers.map((server) => ({
				id: server.id,
				name: server.title,
				badge: server.disabledReason ? "unavailable" : undefined,
				description: description(server),
				detail: server.detail,
				disabledReason: server.disabledReason,
				value: server,
			})),
		},
	];
}

function description(server: McpRegistryItem): string {
	if (server.requiredEnv.length === 0) return server.description;
	const env = `env: ${server.requiredEnv.join(", ")}`;
	return server.description ? `${server.description} · ${env}` : env;
}
