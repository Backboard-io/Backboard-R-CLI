import type { AgentClient } from "../AgentClient.ts";
import { MODEL_CACHE_TTL_MS } from "./constants.ts";
import { normalizeSelectableModels } from "./modelCatalog.ts";
import type { ModelInfo } from "./types.ts";

const modelCache = new WeakMap<
	Pick<AgentClient, "listModels">,
	{
		expiresAt: number;
		models?: ModelInfo[];
		pending?: Promise<ModelInfo[]>;
	}
>();

/**
 * Drops the cached catalog. Called when the credentials behind it change (a
 * `/keys` toggle), since the reachable model set changes with them.
 */
export function resetModelCache(client: Pick<AgentClient, "listModels">): void {
	modelCache.delete(client);
}

/** Fetches and normalizes the model catalog for the model picker. */
export async function fetchModels(
	client: Pick<AgentClient, "listModels">,
): Promise<ModelInfo[]> {
	const now = Date.now();
	const cached = modelCache.get(client);
	if (cached && cached.expiresAt > now) {
		if (cached.models) return [...cached.models];
		if (cached.pending) return [...(await cached.pending)];
	}

	const pending = fetchFreshModels(client);
	const entry = {
		expiresAt: now + MODEL_CACHE_TTL_MS,
		pending,
	};
	modelCache.set(client, entry);

	try {
		const models = await pending;
		// Credential changes delete the cache while an old request may still be
		// in flight. Only the request that still owns the entry may populate it.
		if (modelCache.get(client) === entry) {
			modelCache.set(client, {
				expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
				models,
			});
		}
		return [...models];
	} catch (err) {
		if (modelCache.get(client) === entry) modelCache.delete(client);
		throw err;
	}
}

async function fetchFreshModels(
	client: Pick<AgentClient, "listModels">,
): Promise<ModelInfo[]> {
	const catalog = await client.listModels();
	return normalizeSelectableModels(catalog.models);
}
