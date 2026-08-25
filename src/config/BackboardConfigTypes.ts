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
	/** Expert mode: implementation runs on `model`, planning stays on `/model`. */
	expert?: ExpertConfig;
}

export interface ExpertConfig {
	enabled: boolean;
	/** Remembered across an off/on cycle, so the picker only runs once. */
	model?: {
		provider: string;
		model: string;
	};
	thinking?: ThinkingIntent | null;
}

export interface LoadEnvOptions {
	homeDir?: string;
}

export type BackboardConfigJson = JsonObject;
