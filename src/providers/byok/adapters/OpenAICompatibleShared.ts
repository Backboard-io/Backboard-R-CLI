import type { CustomModelDefinition } from "../../../config/providers.ts";
import { joinProviderUrl } from "../../../config/providers.ts";
import type { ModelCatalogItem } from "../../backboard/types.ts";
import type { ConfigurableAdapterOptions } from "./ConfigurableAdapterTypes.ts";

export interface OpenAICompatibleModelsResponse {
	data?: Array<{ id?: string; name?: string; created?: number }>;
	models?: Array<{ id?: string; name?: string; created?: number }>;
}

export function openAICompatibleHeaders(
	key: string,
	options: ConfigurableAdapterOptions,
): Record<string, string> {
	return {
		...(key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {}),
		...options.headers,
	};
}

export function configurableModelsUrl(
	options: ConfigurableAdapterOptions,
): string {
	return joinProviderUrl(options.baseUrl, options.modelsPath ?? "models");
}

export function configuredOpenAIModel(
	provider: string,
	model: CustomModelDefinition,
): ModelCatalogItem {
	return {
		name: model.id,
		provider,
		model_type: "llm",
		...(model.name ? { display_name: model.name } : {}),
		...(model.contextLimit ? { context_limit: model.contextLimit } : {}),
		...(model.maxOutputTokens
			? { max_output_tokens: model.maxOutputTokens }
			: {}),
		...(typeof model.supportsThinking === "boolean"
			? { supports_thinking: model.supportsThinking }
			: { supports_thinking: true }),
		...(model.supportsThinking === false
			? {}
			: { thinking_controls: effortThinkingControls() }),
	};
}

export function effortThinkingControls(): NonNullable<
	ModelCatalogItem["thinking_controls"]
> {
	return {
		supported: true,
		allowed_fields: ["effort"],
		defaults_only: false,
	};
}
