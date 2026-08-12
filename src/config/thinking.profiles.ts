import type { BudgetPolicyId } from "./thinking.budgets.ts";
import type { ThinkingLevel, ThinkingRequestField } from "./thinking.types.ts";

export interface ThinkingProfile {
	readonly id: string;
	readonly fields: readonly ThinkingRequestField[];
	readonly budgetPolicyId?: BudgetPolicyId;
	readonly maxEffort?: Exclude<ThinkingLevel, "max">;
	readonly nativeAdaptive?: boolean;
}

interface ProfileRule extends ThinkingProfile {
	readonly provider: string;
	readonly matches?: (model: string) => boolean;
}

const profileRules: readonly ProfileRule[] = [
	{
		id: "anthropic-adaptive",
		provider: "anthropic",
		matches: requiresAdaptiveThinking,
		fields: ["effort"],
		nativeAdaptive: true,
	},
	{
		id: "anthropic-legacy",
		provider: "anthropic",
		fields: ["budget_tokens"],
		budgetPolicyId: "anthropicLegacy",
	},
	{
		id: "google-gemini-3",
		provider: "google",
		matches: isGemini3,
		fields: ["effort"],
		maxEffort: "high",
		nativeAdaptive: true,
	},
	{
		id: "google-budget",
		provider: "google",
		fields: ["budget_tokens"],
		budgetPolicyId: "google",
	},
	{
		id: "openrouter",
		provider: "openrouter",
		fields: ["max_tokens"],
		budgetPolicyId: "generic",
	},
	{
		id: "cerebras",
		provider: "cerebras",
		fields: ["max_tokens"],
		budgetPolicyId: "generic",
	},
	{
		id: "xai-reasoning",
		provider: "xai",
		matches: isXaiReasoningModel,
		fields: ["effort"],
		maxEffort: "high",
	},
	{
		id: "aws-bedrock-adaptive",
		provider: "aws-bedrock",
		matches: requiresAdaptiveThinking,
		fields: ["effort"],
		nativeAdaptive: true,
	},
	{
		id: "aws-bedrock",
		provider: "aws-bedrock",
		fields: ["effort", "budget_tokens"],
		budgetPolicyId: "anthropicLegacy",
	},
	{
		id: "openai",
		provider: "openai",
		fields: ["effort"],
	},
];

export function fallbackThinkingProfile(
	provider: string,
	model: string,
): ThinkingProfile | null {
	const normalizedProvider = provider.trim().toLowerCase();
	return (
		profileRules.find(
			(rule) =>
				rule.provider === normalizedProvider &&
				(rule.matches === undefined || rule.matches(model)),
		) ?? null
	);
}

function normalizeModel(model: string): string {
	const normalized = model.trim().toLowerCase().replaceAll("_", "-");
	const parts = normalized.split("/");
	return parts[parts.length - 1] ?? normalized;
}

function stripClaudePrefix(model: string): string {
	let normalized = normalizeModel(model);
	for (const prefix of ["us.", "global.", "eu.", "ap.", "anthropic."]) {
		if (normalized.startsWith(prefix)) {
			normalized = normalized.slice(prefix.length);
			break;
		}
	}
	return normalized.replace(/-\d{8}(?:-.*)?$/, "");
}

function requiresAdaptiveThinking(model: string): boolean {
	const match = /^claude-(\w+)-(\d+)(?:-(\d+))?$/.exec(
		stripClaudePrefix(model),
	);
	if (!match) return false;
	const [, variant, majorText, minorText] = match;
	if (!variant || /^\d+$/.test(variant) || !majorText) return false;
	const major = Number(majorText);
	const minor = minorText ? Number(minorText) : 0;
	if (major >= 5) return true;
	return major === 4 && variant === "opus" && minor >= 7;
}

function isGemini3(model: string): boolean {
	return normalizeModel(model).startsWith("gemini-3");
}

function isXaiReasoningModel(model: string): boolean {
	const normalized = normalizeModel(model);
	if (normalized.includes("non-reasoning")) return false;
	return (
		normalized.startsWith("grok-3-mini") ||
		normalized.startsWith("grok-3") ||
		normalized.startsWith("grok-4") ||
		normalized.startsWith("grok-latest")
	);
}
