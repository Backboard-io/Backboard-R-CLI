import type { ByokProviderId } from "../core/keys/ProviderKeyTypes.ts";

export type MemoryMode = "off" | "on" | "auto" | "readonly";
export type MemoryProfile = "default" | "code";
export type OutputFormat = "default" | "json";
export { parseThinking, resolveThinking } from "./thinking.ts";
export type {
	DynamicThinkingEvidence,
	ThinkingConfig,
	ThinkingIntent,
	ThinkingLevel,
	ThinkingModelMetadata,
	ThinkingRequestKind,
} from "./thinking.types.ts";

export interface ModelRef {
	provider: string;
	model: string;
}

export interface AgentDefaults {
	memory: MemoryMode;
	profile: string;
	model: ModelRef;
	finalVerificationNudge: boolean;
}

export const DEFAULTS: AgentDefaults = {
	memory: "auto",
	profile: "coding",
	model: { provider: "openai", model: "gpt-5.5" },
	finalVerificationNudge: true,
};

const KEY_ONLY_DEFAULT_MODELS: Readonly<Record<ByokProviderId, ModelRef>> = {
	anthropic: { provider: "anthropic", model: "claude-opus-5" },
	openai: DEFAULTS.model,
	google: { provider: "google", model: "gemini-2.5-flash" },
	openrouter: {
		provider: "openrouter",
		model: "anthropic/claude-sonnet-4.6",
	},
};

export function keyOnlyDefaultModel(
	provider: ByokProviderId | undefined,
): ModelRef | null {
	return provider ? KEY_ONLY_DEFAULT_MODELS[provider] : null;
}

export function formatModel(ref: ModelRef): string {
	return `${ref.provider}/${ref.model}`;
}

export function parseModel(value: string): ModelRef {
	const trimmed = value.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		return { provider: DEFAULTS.model.provider, model: trimmed };
	}
	return {
		provider: trimmed.slice(0, slash),
		model: trimmed.slice(slash + 1),
	};
}

export function parseMemoryMode(value: string): MemoryMode {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "off":
		case "false":
		case "0":
			return "off";
		case "on":
		case "true":
		case "1":
			return "on";
		case "auto":
			return "auto";
		case "readonly":
		case "read-only":
		case "read_only":
			return "readonly";
		default:
			throw new Error("memory must be one of: off, on, auto, readonly");
	}
}

export function formatBackboardMemoryMode(mode: MemoryMode): string {
	switch (mode) {
		case "auto":
		case "on":
			return "Auto";
		case "readonly":
			return "Readonly";
		case "off":
			return "off";
	}
}

export function parseOutputFormat(value: string): OutputFormat {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "":
		case "default":
			return "default";
		case "json":
			return "json";
		default:
			throw new Error("format must be one of: default, json");
	}
}

export function parseMemoryProfile(value: string): MemoryProfile {
	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "":
		case "default":
			return "default";
		case "code":
		case "coding":
			return "code";
		default:
			throw new Error("memory profile must be one of: default, code, coding");
	}
}

export function parseExcludedTools(values: string[]): string[] {
	const excluded: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		for (const raw of value.split(",")) {
			const name = raw.trim();
			if (name && !seen.has(name)) {
				seen.add(name);
				excluded.push(name);
			}
		}
	}
	return excluded;
}
