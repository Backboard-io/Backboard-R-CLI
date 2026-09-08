import { resolveAuth } from "../../config/auth.ts";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../../config/backboardConfig.ts";
import {
	type CustomProviderDefinition,
	normalizeCustomProviderDefinition,
	normalizeProviderId,
} from "../../config/providers.ts";
import { ByokError } from "../../providers/byok/ByokError.ts";
import {
	ProviderRegistry,
	RESERVED_PROVIDER_IDS,
} from "../../providers/byok/registry.ts";
import { errorMessage } from "../../utils/errors.ts";
import {
	readProviderKeys,
	removeProviderKey,
	setProviderKey,
	setProviderKeyEnabled,
} from "./ProviderKeyStore.ts";
import {
	type ByokProviderId,
	maskProviderKey,
	type ProviderKeyControllerOptions,
	type ProviderKeyStatus,
} from "./ProviderKeyTypes.ts";

/**
 * The `/keys` and BYOK-setup surface. Owns validate-then-save so no unusable
 * key ever reaches disk, and keeps every mutation funnelled through one place
 * that notifies the running session.
 */
export class ProviderKeyController {
	constructor(private readonly options: ProviderKeyControllerOptions = {}) {}

	/** Every supported provider, configured or not, in display order. */
	list(): ProviderKeyStatus[] {
		const saved = readProviderKeys(this.options.homeDir);
		const definitions =
			readBackboardConfig(this.options.homeDir).providers ?? [];
		const registry = new ProviderRegistry(definitions, {
			includeDisabled: true,
		});
		const statuses: ProviderKeyStatus[] = registry.adapters.map((adapter) => {
			const entry = saved[adapter.id];
			const definition = definitions.find(
				(candidate) => candidate.id === adapter.id,
			);
			const auth = definition?.auth ?? { type: "apiKey" as const };
			const credential = registry.credentialFor(adapter.id, entry);
			return {
				provider: adapter.id,
				label: adapter.label,
				configured: definition
					? auth.type !== "apiKey" || entry !== undefined
					: entry !== undefined,
				masked: entry
					? maskProviderKey(entry.key)
					: auth.type === "none"
						? "keyless"
						: auth.type === "env"
							? `$${auth.variable}`
							: adapter.keyHint,
				enabled:
					(definition?.enabled ?? true) &&
					credential !== null &&
					(definition ? true : (entry?.enabled ?? false)),
				addedAt: entry?.addedAt ?? null,
				...(definition
					? {
							custom: true,
							protocol: definition.protocol,
							baseUrl: definition.baseUrl,
						}
					: {}),
			};
		});
		for (const definition of definitions) {
			if (statuses.some((status) => status.provider === definition.id))
				continue;
			const entry = saved[definition.id];
			statuses.push({
				provider: definition.id,
				label: definition.name,
				configured: true,
				masked: entry ? maskProviderKey(entry.key) : "configuration error",
				enabled: false,
				addedAt: entry?.addedAt ?? null,
				custom: true,
				protocol: definition.protocol,
				baseUrl: definition.baseUrl,
				error:
					registry.error(definition.id)?.message ??
					"Provider configuration is unavailable.",
			});
		}
		return statuses;
	}

	/**
	 * Validates a key against the vendor, then saves it enabled. A key that
	 * fails here is never written, so `/keys` can only ever list keys that
	 * worked at least once.
	 */
	async add(
		provider: ByokProviderId,
		key: string,
		signal?: AbortSignal,
	): Promise<void> {
		const adapter = this.registry(true).get(provider);
		if (!adapter) throw new Error(`Unknown provider: ${provider}`);
		const trimmed = key.trim();
		if (!trimmed) {
			throw new Error(`Enter a ${adapter.label} API key.`);
		}
		if (!adapter.looksLikeKey(trimmed)) {
			throw new Error(
				`That does not look like a ${adapter.label} key (expected ${adapter.keyHint}).`,
			);
		}

		try {
			await adapter.validateKey(trimmed, signal);
		} catch (err) {
			throw new Error(validationMessage(adapter.label, err));
		}

		await setProviderKey(provider, trimmed, this.options.homeDir);
		this.options.onChange?.();
	}

	async setEnabled(provider: ByokProviderId, enabled: boolean): Promise<void> {
		const definition = this.definition(provider);
		if (definition) {
			await this.saveDefinition({ ...definition, enabled });
			this.options.onChange?.();
			return;
		}
		await setProviderKeyEnabled(provider, enabled, this.options.homeDir);
		this.options.onChange?.();
	}

	async toggle(provider: ByokProviderId): Promise<boolean> {
		const current = this.list().find((entry) => entry.provider === provider);
		if (!current?.configured) return false;
		const next = !current.enabled;
		await this.setEnabled(provider, next);
		return next;
	}

	async remove(provider: ByokProviderId): Promise<void> {
		const config = readBackboardConfig(this.options.homeDir);
		const definitions = config.providers ?? [];
		if (definitions.some((entry) => entry.id === provider)) {
			await saveBackboardConfig(
				{
					...config,
					providers: definitions.filter((entry) => entry.id !== provider),
					...(config.model?.provider === provider ? { model: undefined } : {}),
				},
				this.options.homeDir,
			);
		}
		await removeProviderKey(provider, this.options.homeDir);
		this.options.onChange?.();
	}

	customProviders(): CustomProviderDefinition[] {
		return readBackboardConfig(this.options.homeDir).providers ?? [];
	}

	async addCustomProvider(
		definition: CustomProviderDefinition,
		apiKey?: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.saveCustomProvider(definition, apiKey, undefined, signal);
	}

	async saveCustomProvider(
		definition: CustomProviderDefinition,
		apiKey?: string,
		previousId?: string,
		signal?: AbortSignal,
	): Promise<void> {
		const requestedId = normalizeProviderId(definition.id);
		if (RESERVED_PROVIDER_IDS.has(requestedId)) {
			throw new Error(
				`Provider id "${requestedId}" is reserved for a built-in provider.`,
			);
		}
		const candidate = normalizeCustomProviderDefinition(definition);
		const existing = this.customProviders();
		const duplicate = existing.find(
			(entry) => entry.id === candidate.id && entry.id !== previousId,
		);
		if (duplicate) {
			throw new Error(`A provider with id "${candidate.id}" already exists.`);
		}
		const registry = new ProviderRegistry([candidate], {
			includeDisabled: true,
		});
		const adapter = registry.get(candidate.id);
		if (!adapter) {
			const registryError = registry.error(candidate.id);
			if (registryError) throw registryError;
			throw new Error(
				`Provider id "${candidate.id}" conflicts with a built-in.`,
			);
		}
		const auth = candidate.auth ?? { type: "apiKey" as const };
		const saved = readProviderKeys(this.options.homeDir);
		const key =
			auth.type === "apiKey"
				? (apiKey?.trim() ??
					(previousId ? saved[previousId]?.key : undefined) ??
					"")
				: auth.type === "env"
					? (process.env[auth.variable]?.trim() ?? "")
					: "";
		if (auth.type !== "none" && !key) {
			throw new Error(
				auth.type === "env"
					? `Environment variable ${auth.variable} is not set.`
					: `Enter credentials for ${candidate.name}.`,
			);
		}
		let models: string[];
		try {
			models = (await adapter.listModels(key, signal)).map(
				(model) => model.name,
			);
		} catch (err) {
			if (err instanceof ByokError && err.isAuthFailure) {
				throw new Error(validationMessage(adapter.label, err));
			}
			throw new Error(
				`Could not load models from ${adapter.label}: ${errorMessage(err)}`,
			);
		}
		if (models.length === 0) {
			throw new Error(
				`${adapter.label} did not expose any models. Enable discovery or add at least one manual model.`,
			);
		}
		await this.saveDefinition(candidate, previousId, models);
		if (auth.type === "apiKey") {
			await setProviderKey(candidate.id, key, this.options.homeDir);
		} else {
			await removeProviderKey(candidate.id, this.options.homeDir);
		}
		if (previousId && previousId !== candidate.id) {
			await removeProviderKey(previousId, this.options.homeDir);
		}
		this.options.onChange?.();
	}

	private registry(includeDisabled = false): ProviderRegistry {
		return new ProviderRegistry(this.customProviders(), { includeDisabled });
	}

	definition(provider: string): CustomProviderDefinition | undefined {
		return this.customProviders().find((entry) => entry.id === provider);
	}

	private async saveDefinition(
		definition: CustomProviderDefinition,
		previousId = definition.id,
		models: readonly string[] = [],
	): Promise<void> {
		const config = readBackboardConfig(this.options.homeDir);
		const auth = resolveAuth({ homeDir: this.options.homeDir });
		const currentProvider = config.model?.provider;
		const currentIsCustom = Boolean(
			currentProvider &&
				config.providers?.some((provider) => provider.id === currentProvider),
		);
		const hasDirectProvider = Boolean(
			currentProvider &&
				auth.providerKeys.some((entry) => entry.provider === currentProvider),
		);
		const currentModelReachable =
			hasDirectProvider || (!currentIsCustom && auth.backboard !== null);
		const providers = config.providers ?? [];
		const index = providers.findIndex((entry) => entry.id === previousId);
		const next =
			index < 0
				? [...providers, definition]
				: providers.map((entry, position) =>
						position === index ? definition : entry,
					);
		await saveBackboardConfig(
			{
				...config,
				providers: next,
				...(config.model?.provider === previousId && models[0]
					? {
							model: {
								provider: definition.id,
								model: models.includes(config.model.model)
									? config.model.model
									: models[0],
							},
						}
					: (!config.model || !currentModelReachable) && models[0]
						? { model: { provider: definition.id, model: models[0] } }
						: {}),
			},
			this.options.homeDir,
		);
	}
}

function validationMessage(label: string, err: unknown): string {
	if (err instanceof ByokError && err.isAuthFailure) {
		return `${label} rejected that key. Check it was copied in full and is still active.`;
	}
	const message = errorMessage(err);
	return `Could not verify the ${label} key: ${message}`;
}
