/**
 * Prompt profile identifiers. These mirror the model-profile names produced by
 * `resolveModelProfile`, but live in their own dependency-free module so any
 * prompt module can reference the type without import cycles.
 */
export type PromptProfileId = "default" | "openai" | "anthropic" | "glm";

export const PROMPT_PROFILE_IDS: readonly PromptProfileId[] = [
	"default",
	"openai",
	"anthropic",
	"glm",
];

/**
 * Maps an arbitrary model-profile name to a known prompt profile, falling back
 * to `default` for anything unrecognized.
 */
export function toPromptProfileId(name: string | undefined): PromptProfileId {
	const normalized = (name ?? "").trim().toLowerCase();
	return normalized === "openai" ||
		normalized === "anthropic" ||
		normalized === "glm"
		? normalized
		: "default";
}
