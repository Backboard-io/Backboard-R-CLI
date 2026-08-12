import { Box, Text, useInput } from "ink";
import type React from "react";
import type { McpServerRuntimeStatus } from "../../core/mcp/index.ts";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { mcpStatusColor, mcpStatusLabel } from "./MCPServerStatus.ts";
import { Panel } from "./Panel.tsx";
import { SelectCaret } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	server: McpServerRuntimeStatus;
	onAuthenticate: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onDisable: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onRemove: (
		server: McpServerRuntimeStatus,
		signal: AbortSignal,
	) => Promise<void> | void;
	onBrowse: (server: McpServerRuntimeStatus, signal: AbortSignal) => void;
	onCancel: () => void;
}

type ActionId = "browse" | "authenticate" | "disable" | "remove";

interface ServerAction {
	id: ActionId;
	label: string;
	enabled: boolean;
	disabledReason?: string;
}

export function McpServerActions({
	server,
	onAuthenticate,
	onDisable,
	onRemove,
	onBrowse,
	onCancel,
}: Props): React.ReactElement {
	const actions = serverActions(server);
	const selection = useListSelection(actions.length, { digitJump: true });
	const asyncAction = useAsyncAction();

	const runSelectedAction = (): void => {
		const action = actions[selection.index];
		if (!action) return;
		if (!action.enabled) {
			asyncAction.setError(
				action.disabledReason ?? `${action.label} is unavailable.`,
			);
			return;
		}
		if (action.id === "browse") {
			asyncAction.run("Loading MCP prompts and resources", async (signal) => {
				await onBrowse(server, signal);
			});
			return;
		}
		if (action.id === "authenticate") {
			asyncAction.run("Authenticating MCP server", async (signal) => {
				await onAuthenticate(server, signal);
			});
			return;
		}
		if (action.id === "disable") {
			asyncAction.run("Disabling MCP server", async (signal) => {
				await onDisable(server, signal);
			});
			return;
		}
		if (action.id === "remove") {
			asyncAction.run("Removing MCP server", async (signal) => {
				await onRemove(server, signal);
			});
		}
	};

	useInput((input, key) => {
		if (asyncAction.running) {
			if (key.escape) asyncAction.cancel();
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) {
			asyncAction.setError(null);
			return;
		}
		if (key.return) {
			runSelectedAction();
		}
	});

	return (
		<Panel title={`MCP Server: ${server.name}`}>
			<Text>
				<Text color={theme.subtle}>status </Text>
				<Text color={mcpStatusColor(server.status)}>
					{mcpStatusLabel(server.status)}
				</Text>
			</Text>
			<Text color={theme.subtle}>
				type {server.type.toUpperCase()} · tools {server.toolNames.length}
			</Text>
			{server.message ? (
				<Text color={theme.error}>{server.message}</Text>
			) : null}
			<Text>
				<Text color={theme.subtle}>prompts </Text>
				<Text>{server.promptNames?.length ?? 0}</Text>
				<Text color={theme.subtle}> · resources </Text>
				<Text>{server.resourceUris?.length ?? 0}</Text>
			</Text>
			<Text color={theme.subtle}>
				supported {primitiveSupportLabel(server)} · subscribed{" "}
				{server.subscribedResourceUris?.length ?? 0} · updated{" "}
				{server.updatedResourceUris?.length ?? 0}
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{actions.map((action, index) => {
					const selected = index === selection.index;
					const color = action.enabled
						? selected
							? theme.accentBright
							: theme.subtle
						: theme.subtle;
					return (
						<Box key={action.id}>
							<SelectCaret selected={selected} color={color} />
							<Text color={color} bold={selected && action.enabled}>
								{action.label}
							</Text>
						</Box>
					);
				})}
			</Box>
			<ErrorLine error={asyncAction.error} />
			<HintFooter
				marginTop={0}
				hints={
					asyncAction.running
						? ["Esc cancel action"]
						: ["↑/↓ choose", "1-4 jump", "Enter select", "Esc back"]
				}
			/>
			{asyncAction.running && asyncAction.label ? (
				<Spinner label={asyncAction.label} />
			) : null}
		</Panel>
	);
}

function serverActions(server: McpServerRuntimeStatus): ServerAction[] {
	const canAuthenticate = canAuthenticateMcpServer(server);
	return [
		{
			id: "browse",
			label: "Browse Prompts & Resources",
			enabled: server.status === "connected",
			disabledReason: `${server.name} is not connected.`,
		},
		{
			id: "authenticate",
			label: server.status === "connected" ? "Re-authenticate" : "Authenticate",
			enabled: canAuthenticate,
			disabledReason:
				server.type !== "http"
					? "Only HTTP MCP servers support browser authentication."
					: `Authentication is not available while ${server.name} is ${mcpStatusLabel(server.status)}.`,
		},
		{
			id: "disable",
			label: "Disable",
			enabled: server.status !== "disabled",
			disabledReason: `${server.name} is already disabled.`,
		},
		{
			id: "remove",
			label: "Remove Server",
			enabled: true,
		},
	];
}

export function canAuthenticateMcpServer(
	server: McpServerRuntimeStatus,
): boolean {
	return server.type === "http" && server.status !== "disabled";
}

function primitiveSupportLabel(server: McpServerRuntimeStatus): string {
	const capabilities = server.capabilities;
	if (!capabilities) return "unknown";
	const labels = [
		capabilities.prompts ? "prompts" : "",
		capabilities.resources ? "resources" : "",
		capabilities.resources?.subscribe ? "subscriptions" : "",
	].filter(Boolean);
	return labels.length > 0 ? labels.join(", ") : "tools only";
}
