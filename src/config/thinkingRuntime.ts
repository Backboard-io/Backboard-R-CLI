import type { AgentClient } from "../providers/AgentClient.ts";
import type { Config } from "./Config.ts";
import type { ThinkingConfig } from "./defaults.ts";
import { resolveThinking } from "./defaults.ts";
import type {
	DynamicThinkingEvidence,
	ThinkingIntent,
	ThinkingModelMetadata,
} from "./thinking.types.ts";

export interface RuntimeThinkingResolver {
	intent: ThinkingIntent | null | undefined;
	resolve(evidence: DynamicThinkingEvidence): ThinkingConfig | null | undefined;
}

export async function resolveRuntimeThinking(
	config: Pick<Config, "model" | "thinkingIntent">,
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	evidence: DynamicThinkingEvidence = {
		phase: "initial",
		requestKind: "user",
	},
): Promise<ThinkingConfig | null | undefined> {
	const resolver = await createRuntimeThinkingResolver(config, client);
	return resolver.resolve(evidence);
}

export async function createRuntimeThinkingResolver(
	config: Pick<Config, "model" | "thinkingIntent">,
	client: Pick<AgentClient, "getModelThinkingMetadata">,
): Promise<RuntimeThinkingResolver> {
	const intent = config.thinkingIntent;
	const model = config.model;
	const metadata =
		intent === undefined || intent === null
			? null
			: await findModelInfo(client, model).catch(() => null);
	return {
		intent,
		resolve(evidence) {
			if (evidence.phase === "tool_outputs" && intent?.kind !== "dynamic") {
				return undefined;
			}
			return resolveThinking({
				intent,
				model,
				metadata,
				dynamicEvidence: evidence,
			});
		},
	};
}

async function findModelInfo(
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	model: { provider: string; model: string },
): Promise<ThinkingModelMetadata | null> {
	return client.getModelThinkingMetadata(model.provider, model.model);
}
