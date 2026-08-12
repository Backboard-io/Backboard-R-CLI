import { DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD } from "./thinking.constants.ts";
import type {
	DynamicThinkingEvidence,
	ThinkingLevel,
} from "./thinking.types.ts";

export type DynamicThinkingDecision = "defer" | ThinkingLevel;

export function resolveDynamicThinkingLevel(
	evidence: DynamicThinkingEvidence | undefined,
): ThinkingLevel {
	if (evidence?.phase !== "tool_outputs") {
		return evidence?.hasDiagnosticText ? "high" : "medium";
	}

	const round = evidence.toolRound;
	if (!round) return "medium";

	const failed = round.hadToolError || round.hadNonZeroExit || round.hadTimeout;
	if (!failed) return "medium";

	if (
		round.consecutiveFailureCount >= DYNAMIC_THINKING_MAX_FAILURE_THRESHOLD &&
		!round.maxUsed
	) {
		return "max";
	}

	return "high";
}

export function shouldDeferDynamicThinking(
	nativeAdaptive: boolean,
	evidence: DynamicThinkingEvidence | undefined,
): boolean {
	if (!nativeAdaptive) return false;
	if (evidence?.phase !== "tool_outputs") return true;
	const round = evidence.toolRound;
	if (!round) return true;
	return !(round.hadToolError || round.hadNonZeroExit || round.hadTimeout);
}
