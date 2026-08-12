import type React from "react";
import type { McpServerRuntimeStatus } from "../../core/mcp/index.ts";
import { mcpStatusColor, mcpStatusLabel } from "./MCPServerStatus.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

export type McpManagerSelection =
	| { type: "registry" }
	| { type: "manual" }
	| { type: "server"; server: McpServerRuntimeStatus };

interface Props {
	servers: McpServerRuntimeStatus[];
	onSelect: (selection: McpManagerSelection) => void;
	onCancel: () => void;
}

export function McpManagerSelector({
	servers,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title="Manage MCP servers"
			tabs={tabs(servers)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No MCP servers yet."
		/>
	);
}

function tabs(
	servers: readonly McpServerRuntimeStatus[],
): PickerTab<McpManagerSelection>[] {
	return [
		{
			id: "mcp",
			label: "MCP servers",
			items: [
				{
					id: "registry",
					name: "+ Add from registry",
					description: "Browse the curated MCP catalog",
					value: { type: "registry" },
				},
				{
					id: "manual",
					name: "+ Add manually",
					description: "Enter a URL or command",
					value: { type: "manual" },
				},
				...servers.map((server, index) => ({
					id: server.name,
					name: server.name,
					badge: mcpStatusLabel(server.status),
					badgeColor: mcpStatusColor(server.status),
					description: `${server.type.toUpperCase()} · ${server.toolNames.length} tools`,
					detail: server.message,
					spacingBefore: index === 0,
					value: { type: "server" as const, server },
				})),
			],
		},
	];
}
