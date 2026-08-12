import {
	BYOK_PROVIDER_IDS,
	type ByokProviderId,
	isByokProviderId,
} from "../../core/keys/ProviderKeyTypes.ts";
import { anthropicAdapter } from "./adapters/AnthropicAdapter.ts";
import { googleAdapter } from "./adapters/GoogleAdapter.ts";
import { openaiAdapter } from "./adapters/OpenAIAdapter.ts";
import { openRouterAdapter } from "./adapters/OpenRouterAdapter.ts";
import type { ProviderAdapter } from "./ByokTypes.ts";

/**
 * The single place a provider is registered. Adding a vendor means writing one
 * adapter and adding it here plus to BYOK_PROVIDER_IDS - `/keys`, the BYOK
 * setup flow, the model catalog, and request routing all read from this map.
 */
export const BYOK_ADAPTERS: Record<ByokProviderId, ProviderAdapter> = {
	anthropic: anthropicAdapter,
	openai: openaiAdapter,
	google: googleAdapter,
	openrouter: openRouterAdapter,
};

/** Adapters in a stable display order for pickers. */
export const BYOK_ADAPTER_LIST: readonly ProviderAdapter[] =
	BYOK_PROVIDER_IDS.map((id) => BYOK_ADAPTERS[id]);

export function byokAdapter(id: ByokProviderId): ProviderAdapter {
	return BYOK_ADAPTERS[id];
}

/** Resolves a catalog provider string (e.g. from `provider/model`) to an adapter. */
export function byokAdapterFor(provider: string): ProviderAdapter | null {
	const normalized = provider.trim().toLowerCase();
	if (isByokProviderId(normalized)) return BYOK_ADAPTERS[normalized];
	// Backboard names Gemini's provider "google"; accept the common aliases so
	// a model selected from either catalog routes the same way.
	if (normalized === "gemini" || normalized === "google-gemini") {
		return BYOK_ADAPTERS.google;
	}
	return null;
}
