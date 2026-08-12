import type React from "react";
import type {
	McpPromptDefinition,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
} from "../../core/mcp/index.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

export type McpPrimitiveSelection =
	| { type: "prompt"; prompt: McpPromptDefinition }
	| {
			type: "resource";
			action: "read" | "subscribe" | "unsubscribe";
			resource: McpResourceDefinition;
	  }
	| { type: "template"; template: McpResourceTemplateDefinition };

interface Props {
	serverName: string;
	prompts: McpPromptDefinition[];
	resources: McpResourceDefinition[];
	templates: McpResourceTemplateDefinition[];
	resourceSubscriptions: boolean;
	subscribedResourceUris: string[];
	updatedResourceUris: string[];
	onSelect: (
		selection: McpPrimitiveSelection,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function McpPrimitiveSelector({
	serverName,
	prompts,
	resources,
	templates,
	resourceSubscriptions,
	subscribedResourceUris,
	updatedResourceUris,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title={`MCP ${serverName}`}
			tabs={tabs({
				prompts,
				resources,
				templates,
				resourceSubscriptions,
				subscribedResourceUris,
				updatedResourceUris,
			})}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No MCP prompts or resources."
			selectingLabel="Loading MCP item"
		/>
	);
}

function tabs(options: {
	prompts: readonly McpPromptDefinition[];
	resources: readonly McpResourceDefinition[];
	templates: readonly McpResourceTemplateDefinition[];
	resourceSubscriptions: boolean;
	subscribedResourceUris: readonly string[];
	updatedResourceUris: readonly string[];
}): PickerTab<McpPrimitiveSelection>[] {
	const subscribedUris = new Set(options.subscribedResourceUris);
	const updatedUris = new Set(options.updatedResourceUris);
	return [
		{
			id: "prompts",
			label: "Prompts",
			items: options.prompts.map((prompt) => {
				const requiredArgs = (prompt.arguments ?? [])
					.filter((arg) => arg.required)
					.map((arg) => arg.name);
				return {
					id: prompt.name,
					name: `/${prompt.name}`,
					badge:
						requiredArgs.length > 0
							? `args: ${requiredArgs.join(", ")}`
							: undefined,
					description: prompt.description,
					detail: prompt.description,
					value: { type: "prompt", prompt },
				};
			}),
		},
		{
			id: "resources",
			label: "Resources",
			items: options.resources.map((resource) => ({
				id: `read:${resource.uri}`,
				name: `/read ${resource.name}`,
				badge: updatedUris.has(resource.uri) ? "updated" : undefined,
				description: resource.mimeType ?? resource.uri,
				detail: resource.description || resource.uri,
				value: { type: "resource", action: "read", resource },
			})),
		},
		{
			id: "templates",
			label: "Templates",
			items: options.templates.map((template) => ({
				id: template.uriTemplate,
				name: `/${template.name}`,
				description: template.uriTemplate,
				detail: template.description || template.uriTemplate,
				value: { type: "template", template },
			})),
		},
		{
			id: "subscriptions",
			label: "Subscriptions",
			items: options.resources.map((resource) => {
				const subscribed = subscribedUris.has(resource.uri);
				return {
					id: `${subscribed ? "unsubscribe" : "subscribe"}:${resource.uri}`,
					name: `/${subscribed ? "unsubscribe" : "subscribe"} ${resource.name}`,
					badge: subscribed
						? updatedUris.has(resource.uri)
							? "updated"
							: "subscribed"
						: undefined,
					description: resource.uri,
					detail: resource.description || resource.uri,
					disabledReason: options.resourceSubscriptions
						? undefined
						: "This MCP server does not support resource subscriptions.",
					value: {
						type: "resource",
						action: subscribed ? "unsubscribe" : "subscribe",
						resource,
					},
				};
			}),
		},
	];
}
