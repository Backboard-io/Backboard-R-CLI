import type { AgentClient } from "../../providers/AgentClient.ts";
import { resetModelCache } from "../../providers/backboard/models.ts";

export function refreshCredentials(
	config: { refreshAuth(): void },
	client: Pick<AgentClient, "listModels">,
): void {
	config.refreshAuth();
	resetModelCache(client);
}
