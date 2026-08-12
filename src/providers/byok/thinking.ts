import type { ThinkingConfig, ThinkingLevel } from "../../config/defaults.ts";
import { resolveBudget } from "../../config/thinking.budgets.ts";
import { fallbackThinkingProfile } from "../../config/thinking.profiles.ts";

/**
 * `ThinkingConfig` is the union Backboard accepts (`effort`, `budget_tokens`,
 * or `max_tokens`). Direct vendor APIs each take exactly one of those shapes,
 * so these helpers collapse the union per provider rather than making every
 * adapter re-derive it.
 */

/**
 * Whether a model takes the vendor's newer "decide for yourself, at this
 * effort" control (Claude 5's adaptive thinking, Gemini 3's thinking level)
 * rather than an explicit token budget. Sending the wrong one is a hard 400 on
 * Anthropic, so both adapters branch on this - and both read the answer from
 * the model's thinking profile, which is what the resolver already used to
 * shape the config, rather than each keeping its own model-name test.
 */
export function usesNativeAdaptiveThinking(
	provider: string,
	model: string,
): boolean {
	return fallbackThinkingProfile(provider, model)?.nativeAdaptive === true;
}

function level(thinking: ThinkingConfig): ThinkingLevel | null {
	return "effort" in thinking ? thinking.effort : null;
}

function tokens(thinking: ThinkingConfig): number | null {
	if ("budget_tokens" in thinking) return thinking.budget_tokens;
	if ("max_tokens" in thinking) return thinking.max_tokens;
	return null;
}

/** Anthropic and Google both want an explicit token budget. */
export function thinkingBudgetTokens(
	thinking: ThinkingConfig | null | undefined,
	policy: "anthropicLegacy" | "google",
	maxOutputTokens?: number,
): number | null {
	if (!thinking) return null;
	const explicit = tokens(thinking);
	if (explicit !== null) return explicit;
	const requested = level(thinking);
	if (requested === null) return null;
	return resolveBudget(policy, requested, {
		field: "budget_tokens",
		metadata: maxOutputTokens
			? { provider: "", model: "", max_output_tokens: maxOutputTokens }
			: null,
	});
}

/** OpenAI takes a named effort; "max" has no wire equivalent, so it maps to high. */
export function thinkingEffort(
	thinking: ThinkingConfig | null | undefined,
): "low" | "medium" | "high" | null {
	const requested = thinkingLevel(thinking);
	return requested === "max" ? "high" : requested;
}

/**
 * The named effort as asked for, "max" included - Anthropic's adaptive thinking
 * accepts the full scale, so unlike OpenAI it needs no downgrade.
 */
export function thinkingLevel(
	thinking: ThinkingConfig | null | undefined,
): ThinkingLevel | null {
	if (!thinking) return null;
	const requested = level(thinking);
	if (requested !== null) return requested;
	// A caller that asked in tokens still wants *some* reasoning; bucket it
	// rather than silently dropping the request.
	const budget = tokens(thinking);
	if (budget === null) return null;
	if (budget <= 2048) return "low";
	if (budget <= 8192) return "medium";
	return "high";
}
