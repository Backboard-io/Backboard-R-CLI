import { describe, expect, it } from "bun:test";
import { fetchModels } from "../src/providers/backboard/models.ts";
import type { ModelsListResponse } from "../src/providers/backboard/types.ts";
import { refreshCredentials } from "../src/ui/utils/refreshCredentials.ts";

describe("refreshCredentials", () => {
	it("reloads auth and invalidates the model catalog cache", async () => {
		let authRefreshes = 0;
		let catalogLoads = 0;
		const config = {
			refreshAuth: () => {
				authRefreshes++;
				return {
					backboard: null,
					providerKeys: [],
				};
			},
		};
		const client = {
			listModels: async (): Promise<ModelsListResponse> => {
				catalogLoads++;
				return {
					models: [{ name: "model", provider: "provider", model_type: "llm" }],
					total: 1,
				};
			},
		};

		await fetchModels(client);
		await fetchModels(client);
		expect(catalogLoads).toBe(1);

		refreshCredentials(config, client);
		await fetchModels(client);

		expect(authRefreshes).toBe(1);
		expect(catalogLoads).toBe(2);
	});

	it("does not let an invalidated in-flight catalog refill the cache", async () => {
		let resolveFirst: ((value: ModelsListResponse) => void) | undefined;
		let catalogLoads = 0;
		const first = new Promise<ModelsListResponse>((resolve) => {
			resolveFirst = resolve;
		});
		const client = {
			listModels: async (): Promise<ModelsListResponse> => {
				catalogLoads++;
				if (catalogLoads === 1) return first;
				return { models: [], total: 0 };
			},
		};
		const pending = fetchModels(client);

		refreshCredentials(
			{
				refreshAuth: () => ({ backboard: null, providerKeys: [] }),
			},
			client,
		);
		resolveFirst?.({ models: [], total: 0 });
		await pending;
		await fetchModels(client);

		expect(catalogLoads).toBe(2);
	});
});
