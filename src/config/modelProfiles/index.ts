import { formatModel, type ModelRef } from "../defaults.ts";
import { defaultModelProfile, MODEL_PROFILES } from "./profiles.ts";
import type { ModelProfile } from "./types.ts";

export {
	combineToolAllowlists,
	combineToolExclusions,
	isAllowedByToolList,
} from "./tools.ts";

export function resolveModelProfile(model: ModelRef): ModelProfile {
	const modelString = formatModel(model).toLowerCase();
	return (
		MODEL_PROFILES.find(
			(profile) =>
				profile !== defaultModelProfile &&
				profile.matchers.some((matcher) =>
					modelString.includes(matcher.toLowerCase()),
				),
		) ?? defaultModelProfile
	);
}

export function listModelProfiles(): ModelProfile[] {
	return [...MODEL_PROFILES];
}

export function getModelProfile(name: string): ModelProfile | undefined {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return undefined;
	return MODEL_PROFILES.find(
		(profile) =>
			profile.name.includes(normalized) ||
			profile.matchers.some((matcher) =>
				matcher.toLowerCase().includes(normalized),
			),
	);
}

export type { ModelProfile, SystemPromptLayout } from "./types.ts";
