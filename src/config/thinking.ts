import { resolveBudget } from "./thinking.budgets.ts";
import { THINKING_LEVELS } from "./thinking.constants.ts";
import type {
	ThinkingConfig,
	ThinkingIntent,
	ThinkingLevel,
	ThinkingResolveContext,
} from "./thinking.types.ts";
import {
	resolveThinkingCapabilities,
	tokenFieldFor,
} from "./thinkingCapabilities.ts";

export function parseThinking(value: string): ThinkingIntent | null {
	const normalized = value.trim().toLowerCase();
	if (["off", "no", "disable", "disabled", "false", "0"].includes(normalized))
		return null;

	const level = normalized === "maximum" ? "max" : normalized;
	if (isThinkingLevel(level)) return { kind: "level", level };

	const budget = Number(normalized);
	if (Number.isInteger(budget) && budget > 0) {
		return { kind: "budget", tokens: budget };
	}

	throw new Error(
		"thinking must be one of: off, low, medium, high, max, or a token budget",
	);
}

export function resolveThinking(
	context: ThinkingResolveContext,
): ThinkingConfig | null | undefined {
	const { intent, model, metadata } = context;
	if (intent === undefined || intent === null) return intent;

	const capabilities = resolveThinkingCapabilities({ model, metadata });
	const { profile } = capabilities;
	if (!capabilities.supportsThinking) {
		throw new Error(`Thinking is not supported for ${formatModel(model)}.`);
	}
	if (capabilities.defaultsOnly) return {};

	const allowedFields = capabilities.allowedFields;
	if (allowedFields.length === 0) {
		throw new Error(
			`Thinking controls are not available for ${formatModel(model)}.`,
		);
	}

	if (intent.kind === "budget") {
		const tokenField = tokenFieldFor(allowedFields);
		if (!tokenField) {
			throw new Error(
				`Model ${formatModel(model)} accepts thinking levels, not explicit token budgets.`,
			);
		}
		return tokenField === "max_tokens"
			? { max_tokens: intent.tokens }
			: { budget_tokens: intent.tokens };
	}

	if (allowedFields.includes("effort")) {
		return { effort: clampEffort(intent.level, profile?.maxEffort) };
	}

	const tokenField = tokenFieldFor(allowedFields);
	if (!tokenField) {
		throw new Error(
			`Thinking level '${intent.level}' cannot be mapped for ${formatModel(model)}.`,
		);
	}
	const budget = resolveBudget(
		metadata?.thinking_controls?.budget_policy ??
			profile?.budgetPolicyId ??
			"generic",
		intent.level,
		{
			field: tokenField,
			metadata,
		},
	);
	return tokenField === "max_tokens"
		? { max_tokens: budget }
		: { budget_tokens: budget };
}

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

function clampEffort(
	level: ThinkingLevel,
	maxEffort: Exclude<ThinkingLevel, "max"> | undefined,
): ThinkingLevel {
	if (level !== "max" || maxEffort === undefined) return level;
	return maxEffort;
}

// Duplicates defaults.ts formatModel: importing it here would create a cycle,
// since defaults.ts re-exports parseThinking/resolveThinking from this module.
function formatModel(model: { provider: string; model: string }): string {
	return `${model.provider}/${model.model}`;
}
