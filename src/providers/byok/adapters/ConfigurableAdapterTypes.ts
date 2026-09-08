import type { CustomModelDefinition } from "../../../config/providers.ts";

export interface ConfigurableAdapterOptions {
	id: string;
	label: string;
	baseUrl: string;
	consoleUrl?: string;
	keyHint?: string;
	requiresKey?: boolean;
	headers?: Record<string, string>;
	extraArgs?: Record<string, unknown>;
	modelsPath?: string;
	discoverModels?: boolean;
	models?: readonly CustomModelDefinition[];
}
