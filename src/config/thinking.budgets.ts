import type { ThinkingLevel, ThinkingModelMetadata } from "./thinking.types.ts";

export type BudgetPolicyId = "anthropicLegacy" | "google" | "generic";

export interface BudgetContext {
	field: "budget_tokens" | "max_tokens";
	metadata?: ThinkingModelMetadata | null;
}

export interface BudgetPolicy {
	readonly id: BudgetPolicyId;
	resolve(level: ThinkingLevel, context: BudgetContext): number;
}

const genericScale: Record<ThinkingLevel, number> = {
	low: 1024,
	medium: 4096,
	high: 8192,
	max: 24576,
};

const anthropicLegacyScale: Record<ThinkingLevel, number> = {
	low: 2048,
	medium: 8192,
	high: 16384,
	max: 16384,
};

const policies: Record<BudgetPolicyId, BudgetPolicy> = {
	generic: {
		id: "generic",
		resolve: (level, context) =>
			clampToOutputRoom(genericScale[level], context),
	},
	google: {
		id: "google",
		resolve: (level, context) =>
			clampToOutputRoom(genericScale[level], context),
	},
	anthropicLegacy: {
		id: "anthropicLegacy",
		resolve: (level, context) =>
			clampToOutputRoom(anthropicLegacyScale[level], context),
	},
};

export function resolveBudget(
	policyId: BudgetPolicyId,
	level: ThinkingLevel,
	context: BudgetContext,
): number {
	return policies[policyId].resolve(level, context);
}

function clampToOutputRoom(target: number, context: BudgetContext): number {
	if (context.field !== "budget_tokens") return target;
	const maxOutput = context.metadata?.max_output_tokens;
	if (
		typeof maxOutput !== "number" ||
		!Number.isInteger(maxOutput) ||
		maxOutput <= 0
	) {
		return target;
	}
	return Math.max(Math.min(target, maxOutput - 1024), 1024);
}
