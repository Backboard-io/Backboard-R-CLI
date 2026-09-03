import type { CustomProviderDefinition } from "../../config/providers.ts";
import type { StoredProviderKey } from "../../core/keys/ProviderKeyTypes.ts";
import {
	type BuiltinProviderId,
	BYOK_PROVIDER_IDS,
	type ByokProviderId,
} from "../../core/keys/ProviderKeyTypes.ts";
import { anthropicAdapter } from "./adapters/AnthropicAdapter.ts";
import { createCustomProviderAdapter } from "./adapters/CustomProviderAdapter.ts";
import { googleAdapter } from "./adapters/GoogleAdapter.ts";
import { openaiAdapter } from "./adapters/OpenAIAdapter.ts";
import { openRouterAdapter } from "./adapters/OpenRouterAdapter.ts";
import type { ProviderAdapter } from "./ByokTypes.ts";

/**
 * The single place a provider is registered. Adding a vendor means writing one
 * adapter and adding it here plus to BYOK_PROVIDER_IDS - `/keys`, the BYOK
 * setup flow, the model catalog, and request routing all read from this map.
 */
export const BYOK_ADAPTERS: Record<BuiltinProviderId, ProviderAdapter> = {
	anthropic: anthropicAdapter,
	openai: openaiAdapter,
	google: googleAdapter,
	openrouter: openRouterAdapter,
};

/** Adapters in a stable display order for pickers. */
export const BYOK_ADAPTER_LIST: readonly ProviderAdapter[] =
	BYOK_PROVIDER_IDS.map((id) => BYOK_ADAPTERS[id]);
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
	...BYOK_PROVIDER_IDS,
	"gemini",
	"google-gemini",
]);

export class ProviderRegistry {
	readonly adapters: readonly ProviderAdapter[];
	private readonly byId: ReadonlyMap<string, ProviderAdapter>;
	private readonly definitions: ReadonlyMap<string, CustomProviderDefinition>;
	private readonly errors: ReadonlyMap<string, Error>;

	constructor(
		customProviders: readonly CustomProviderDefinition[] = [],
		options: { includeDisabled?: boolean } = {},
	) {
		const adapters = [...BYOK_ADAPTER_LIST];
		const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
		const definitions = new Map<string, CustomProviderDefinition>();
		const errors = new Map<string, Error>();
		for (const definition of customProviders) {
			if (RESERVED_PROVIDER_IDS.has(definition.id)) {
				continue;
			}
			definitions.set(definition.id, definition);
			if (definition.enabled === false && !options.includeDisabled) continue;
			try {
				const adapter = createCustomProviderAdapter(definition);
				adapters.push(adapter);
				byId.set(adapter.id, adapter);
			} catch (error) {
				errors.set(
					definition.id,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		this.adapters = adapters;
		this.byId = byId;
		this.definitions = definitions;
		this.errors = errors;
	}

	get(id: string): ProviderAdapter | null {
		const normalized = id.trim().toLowerCase();
		const direct = this.byId.get(normalized);
		if (direct) return direct;
		if (normalized === "gemini" || normalized === "google-gemini") {
			return this.byId.get("google") ?? null;
		}
		return null;
	}

	definition(id: string): CustomProviderDefinition | null {
		return this.definitions.get(id.trim().toLowerCase()) ?? null;
	}

	error(id: string): Error | null {
		return this.errors.get(id.trim().toLowerCase()) ?? null;
	}

	credentialFor(
		id: string,
		saved: StoredProviderKey | undefined,
		env: NodeJS.ProcessEnv = process.env,
	): string | null {
		const definition = this.definition(id);
		if (!definition) return saved?.enabled ? saved.key : null;
		const auth = definition.auth ?? { type: "apiKey" as const };
		if (auth.type === "none") return "";
		if (auth.type === "env") return env[auth.variable]?.trim() || null;
		return saved?.enabled ? saved.key : null;
	}

	hasCredential(
		id: string,
		saved: StoredProviderKey | undefined,
		env: NodeJS.ProcessEnv = process.env,
	): boolean {
		return this.credentialFor(id, saved, env) !== null;
	}
}

export const BUILTIN_PROVIDER_REGISTRY = new ProviderRegistry();

export function byokAdapter(id: ByokProviderId): ProviderAdapter {
	const adapter = BUILTIN_PROVIDER_REGISTRY.get(id);
	if (!adapter) throw new Error(`Unknown provider: ${id}`);
	return adapter;
}

/** Backward-compatible built-in lookup. Dynamic callers use ProviderRegistry. */
export function byokAdapterFor(provider: string): ProviderAdapter | null {
	return BUILTIN_PROVIDER_REGISTRY.get(provider);
}
