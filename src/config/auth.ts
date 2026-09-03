import { readProviderKeys } from "../core/keys/ProviderKeyStore.ts";
import type { ResolvedProviderKey } from "../core/keys/ProviderKeyTypes.ts";
import { ProviderRegistry } from "../providers/byok/registry.ts";
import { readBackboardConfig } from "./backboardConfig.ts";
import { type BackboardEnv, resolveApiUrl } from "./env.ts";

const PLACEHOLDER_API_KEYS = new Set([
	"your_key_here",
	"<your-api-key>",
	"replace_me",
]);

export const NO_CREDENTIALS_MESSAGE =
	"No credentials found. Sign in with Backboard, or add a provider API key.";

/**
 * Everything the CLI can authenticate with, in one place.
 *
 * Either credential alone is enough to run: a Backboard sign-in unlocks the
 * routed catalog, and a single saved provider key unlocks that vendor's models
 * directly. Only having neither is fatal, which is what the startup auth screen
 * catches.
 */
export interface AuthState {
	/** Present when a Backboard key is set in the env or saved config. */
	backboard: BackboardEnv | null;
	/** Saved provider keys that are currently toggled on. */
	providerKeys: ResolvedProviderKey[];
	providerRegistry?: ProviderRegistry;
}

export interface ResolveAuthOptions {
	homeDir?: string;
}

export function resolveAuth(options: ResolveAuthOptions = {}): AuthState {
	const fileConfig = readBackboardConfig(options.homeDir);
	const envApiKey = process.env.BACKBOARD_API_KEY;
	const apiKey = isUsableApiKey(envApiKey) ? envApiKey : fileConfig.apiKey;
	const apiUrl = resolveApiUrl(fileConfig.apiUrl);

	const providerRegistry = new ProviderRegistry(fileConfig.providers ?? []);
	const savedKeys = readProviderKeys(options.homeDir);
	const providerKeys = providerRegistry.adapters.flatMap((adapter) => {
		const key = providerRegistry.credentialFor(
			adapter.id,
			savedKeys[adapter.id],
		);
		return key === null ? [] : [{ provider: adapter.id, key }];
	});
	return {
		backboard: apiKey ? { apiKey, apiUrl } : null,
		providerKeys,
		providerRegistry,
	};
}

export function hasAnyCredentials(auth: AuthState): boolean {
	return auth.backboard !== null || auth.providerKeys.length > 0;
}

/** Builds the provider -> key lookup `ByokClient` and `ClientRouter` use. */
export function providerKeyResolver(
	auth: AuthState,
): (provider: string) => string | null {
	const byProvider = new Map(
		auth.providerKeys.map((entry) => [entry.provider, entry.key]),
	);
	return (provider) => byProvider.get(provider) ?? null;
}

function isUsableApiKey(value: string | undefined): value is string {
	const trimmed = value?.trim();
	return Boolean(trimmed && !PLACEHOLDER_API_KEYS.has(trimmed));
}
