import type { Config } from "../../config/Config.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { resetModelCache } from "../../providers/backboard/models.ts";

export function refreshCredentials(
	config: Pick<Config, "refreshAuth">,
	client: Pick<AgentClient, "listModels">,
): void {
	config.refreshAuth();
	resetModelCache(client);
}
