/**
 * BYOK (bring-your-own-key) provider identity and storage shapes.
 *
 * A provider id here is always a Backboard catalog provider name too, so a
 * BYOK model and a Backboard-routed model of the same vendor share one
 * `provider/model` string and the `/model` picker can dedupe across sources.
 */
export const BYOK_PROVIDER_IDS = [
	"anthropic",
	"openai",
	"google",
	"openrouter",
] as const;

export type ByokProviderId = (typeof BYOK_PROVIDER_IDS)[number];

export function isByokProviderId(value: string): value is ByokProviderId {
	return (BYOK_PROVIDER_IDS as readonly string[]).includes(value);
}

/** One saved key as it appears on disk in ~/.backboard/keys.json. */
export interface StoredProviderKey {
	key: string;
	/** Disabled keys stay on disk but are ignored when resolving models/clients. */
	enabled: boolean;
	addedAt: string;
}

export type ProviderKeyFile = Partial<
	Record<ByokProviderId, StoredProviderKey>
>;

/** A saved key resolved for use: the secret plus who it belongs to. */
export interface ResolvedProviderKey {
	provider: ByokProviderId;
	key: string;
}

/**
 * UI-facing projection of a saved key. Never carries the secret - only the
 * mask - so it is safe to render, log, and pass through the event bus.
 */
export interface ProviderKeyStatus {
	provider: ByokProviderId;
	label: string;
	/** False for a provider the CLI supports but has no saved key for. */
	configured: boolean;
	/** Masked secret, or the expected key shape when not configured. */
	masked: string;
	enabled: boolean;
	addedAt: string | null;
}

export interface ProviderKeyControllerOptions {
	homeDir?: string;
	/**
	 * Called after any change lands on disk. The CLI uses it to refresh the
	 * live auth state so a toggle takes effect on the next request.
	 */
	onChange?: () => void;
}

/** Masks a secret for display: first 7 and last 4 characters. */
export function maskProviderKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed.length <= 12) return "*".repeat(Math.max(trimmed.length, 4));
	return `${trimmed.slice(0, 7)}…${trimmed.slice(-4)}`;
}
