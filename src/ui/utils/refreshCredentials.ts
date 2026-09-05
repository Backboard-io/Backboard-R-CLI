import { formatModel, type ModelRef } from "../../config/defaults.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { resetModelCache } from "../../providers/backboard/models.ts";

export function refreshCredentials(
	config: { refreshAuth(): void },
	client: Pick<AgentClient, "listModels">,
): void {
	config.refreshAuth();
	resetModelCache(client);
}

export function shouldAdoptPersistedModel(
	explicitModel: string | undefined,
	currentModel: string,
	persistedModel: ModelRef | undefined,
): persistedModel is ModelRef {
	return (
		explicitModel === undefined &&
		persistedModel !== undefined &&
		formatModel(persistedModel) !== currentModel
	);
}
