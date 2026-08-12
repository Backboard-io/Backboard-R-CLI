import type { JsonObject } from "../utils/JsonTypes.ts";
import type { MemoryMode, MemoryProfile, ThinkingIntent } from "./defaults.ts";

export interface BackboardConfigFile {
	apiKey?: string;
	apiUrl?: string;
	model?: {
		provider: string;
		model: string;
	};
	thinking?: ThinkingIntent | null;
	memory?: MemoryMode;
	memoryProfile?: MemoryProfile;
	notify?: boolean;
	verbose?: boolean;
}

export interface LoadEnvOptions {
	homeDir?: string;
}

export type BackboardConfigJson = JsonObject;
