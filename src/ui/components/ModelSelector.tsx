import type React from "react";
import type { ModelInfo } from "../../providers/backboard/types.ts";
import { pluralize } from "../../utils/string.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

interface Props {
	models: ModelInfo[];
	onSelect: (model: ModelInfo) => void;
	onCancel: () => void;
}

interface ModelProvider {
	id: string;
	label: string;
	models: ModelInfo[];
}

export function ModelSelector({
	models,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title={`Select Model · ${formatModelCount(models.length)}`}
			tabs={modelTabs(models)}
			onSelect={(model) => onSelect(model)}
			onCancel={onCancel}
			emptyLabel="No models returned by Backboard."
		/>
	);
}

function modelTabs(models: readonly ModelInfo[]): PickerTab<ModelInfo>[] {
	return modelProviders(models).map((provider) => ({
		id: provider.id,
		label: provider.id === "all" ? "All" : provider.label,
		items: provider.models.map((model) => ({
			id: `${provider.id}:${model.label}`,
			name: model.model,
			badge:
				provider.id === "all" ? displayProvider(model.provider) : undefined,
			// Says where the turn will actually be billed. Only shown once a
			// key-backed model exists, so a signed-in-only catalog stays clean.
			...(model.source === "byok" ? { status: "your key" } : {}),
			value: model,
		})),
	}));
}

function modelProviders(models: readonly ModelInfo[]): ModelProvider[] {
	const byProvider = new Map<string, ModelInfo[]>();
	for (const model of models) {
		const existing = byProvider.get(model.provider) ?? [];
		existing.push(model);
		byProvider.set(model.provider, existing);
	}

	const providers = [...byProvider.entries()].map(
		([provider, providerModels]) => ({
			id: provider,
			label: displayProvider(provider),
			models: providerModels,
		}),
	);

	return [
		{
			id: "all",
			label: "All",
			models: [...models],
		},
		...providers,
	];
}

function formatModelCount(count: number): string {
	return `${count} ${pluralize(count, "model")}`;
}

function displayProvider(provider: string): string {
	if (!provider) return "";
	const normalized = provider.toLowerCase();
	if (normalized === "openai") return "OpenAI";
	if (normalized === "xai") return "xAI";
	return provider
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}
