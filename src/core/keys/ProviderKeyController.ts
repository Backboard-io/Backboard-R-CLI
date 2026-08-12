import { ByokError } from "../../providers/byok/ByokError.ts";
import {
	BYOK_ADAPTER_LIST,
	byokAdapter,
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
		return BYOK_ADAPTER_LIST.map((adapter) => {
			const entry = saved[adapter.id];
			return {
				provider: adapter.id,
				label: adapter.label,
				configured: entry !== undefined,
				masked: entry ? maskProviderKey(entry.key) : adapter.keyHint,
				enabled: entry?.enabled ?? false,
				addedAt: entry?.addedAt ?? null,
			};
		});
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
		const adapter = byokAdapter(provider);
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
		await removeProviderKey(provider, this.options.homeDir);
		this.options.onChange?.();
	}
}

function validationMessage(label: string, err: unknown): string {
	if (err instanceof ByokError && err.isAuthFailure) {
		return `${label} rejected that key. Check it was copied in full and is still active.`;
	}
	const message = errorMessage(err);
	return `Could not verify the ${label} key: ${message}`;
}
