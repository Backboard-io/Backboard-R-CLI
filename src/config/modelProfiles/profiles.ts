import type { ModelProfile } from "./types.ts";

export const defaultModelProfile: ModelProfile = {
	name: "default",
	matchers: [],
	tools: [],
	excludedTools: ["ApplyPatch"],
	systemPromptLayout: {
		base: "core",
	},
};

export const openaiModelProfile: ModelProfile = {
	name: "openai",
	matchers: ["openai"],
	tools: [],
	excludedTools: ["Write", "Edit"],
	systemPromptLayout: {
		base: "core",
	},
};

export const anthropicModelProfile: ModelProfile = {
	name: "anthropic",
	matchers: ["anthropic"],
	tools: [],
	excludedTools: ["ApplyPatch"],
	systemPromptLayout: {
		base: "core",
	},
};

export const glmModelProfile: ModelProfile = {
	name: "glm",
	matchers: ["glm"],
	tools: [],
	excludedTools: ["ApplyPatch"],
	systemPromptLayout: {
		base: "core",
	},
};

export const MODEL_PROFILES: readonly ModelProfile[] = [
	openaiModelProfile,
	anthropicModelProfile,
	glmModelProfile,
	defaultModelProfile,
];
