import {
	type CustomProviderDefinition,
	isCredentialHeader,
	isSecureProviderUrl,
	resolveEnvReferences,
	resolveJsonEnvReferences,
	resolveProviderHeaders,
} from "../../../config/providers.ts";
import type { JsonObject } from "../../../utils/JsonTypes.ts";
import type { ProviderAdapter } from "../ByokTypes.ts";
import { createAnthropicAdapter } from "./AnthropicAdapter.ts";
import { createOpenAIChatAdapter } from "./OpenAIAdapter.ts";
import { createOpenAIResponsesAdapter } from "./OpenAIResponsesAdapter.ts";

export function createCustomProviderAdapter(
	definition: CustomProviderDefinition,
): ProviderAdapter {
	const baseUrl = resolveEnvReferences(
		definition.baseUrl,
		`${definition.name} base URL`,
	);
	const headers = resolveProviderHeaders(definition);
	const modelsPath = definition.modelsPath
		? resolveEnvReferences(
				definition.modelsPath,
				`${definition.name} models path`,
			).trim()
		: undefined;
	const usesCredentials =
		(definition.auth ?? { type: "apiKey" as const }).type !== "none" ||
		Object.keys(headers).some(isCredentialHeader);
	if (usesCredentials && !isSecureProviderUrl(baseUrl)) {
		throw new Error(
			`${definition.name} must use HTTPS when credentials are configured.`,
		);
	}
	if (
		usesCredentials &&
		modelsPath &&
		/^https?:\/\//i.test(modelsPath) &&
		!isSecureProviderUrl(modelsPath)
	) {
		throw new Error(
			`${definition.name} models endpoint must use HTTPS when credentials are configured.`,
		);
	}
	const common = {
		id: definition.id,
		label: definition.name,
		baseUrl,
		requiresKey: (definition.auth ?? { type: "apiKey" }).type !== "none",
		headers,
		extraArgs: definition.extraArgs
			? (resolveJsonEnvReferences(
					definition.extraArgs,
					`${definition.name} extraArgs`,
				) as JsonObject)
			: undefined,
		modelsPath,
		discoverModels: definition.discoverModels,
		models: definition.models?.map((model) => ({
			...model,
			...(model.extraArgs
				? {
						extraArgs: resolveJsonEnvReferences(
							model.extraArgs,
							`${definition.name} model ${model.id} extraArgs`,
						) as JsonObject,
					}
				: {}),
		})),
	};
	switch (definition.protocol) {
		case "openai-chat":
			return createOpenAIChatAdapter(common);
		case "openai-responses":
			return createOpenAIResponsesAdapter(common);
		case "anthropic-messages":
			return createAnthropicAdapter(common);
	}
}
