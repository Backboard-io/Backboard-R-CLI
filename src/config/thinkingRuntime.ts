import type { AgentClient, RequestOptions } from "../providers/AgentClient.ts";
import type { Config } from "./Config.ts";
import type { ThinkingConfig } from "./defaults.ts";
import { resolveThinking } from "./defaults.ts";
import type {
	ThinkingIntent,
	ThinkingModelMetadata,
} from "./thinking.types.ts";

export interface RuntimeThinkingResolver {
	intent: ThinkingIntent | null | undefined;
	resolve(): ThinkingConfig | null | undefined;
}

export async function resolveRuntimeThinking(
	config: Pick<Config, "model" | "thinkingIntent">,
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	options: RequestOptions = {},
): Promise<ThinkingConfig | null | undefined> {
	const resolver = await createRuntimeThinkingResolver(config, client, options);
	return resolver.resolve();
}

/** `options.signal` abandons the metadata lookup; the resolver then has none. */
export async function createRuntimeThinkingResolver(
	config: Pick<Config, "model" | "thinkingIntent">,
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	options: RequestOptions = {},
): Promise<RuntimeThinkingResolver> {
	const intent = config.thinkingIntent;
	const model = config.model;
	const metadata =
		intent === undefined || intent === null
			? null
			: await findModelInfo(client, model, options).catch(() => null);
	return {
		intent,
		resolve() {
			return resolveThinking({ intent, model, metadata });
		},
	};
}

async function findModelInfo(
	client: Pick<AgentClient, "getModelThinkingMetadata">,
	model: { provider: string; model: string },
	options: RequestOptions,
): Promise<ThinkingModelMetadata | null> {
	return client.getModelThinkingMetadata(model.provider, model.model, options);
}
