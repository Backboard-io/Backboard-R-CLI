/**
 * When automatic compression fires.
 *
 * 85% leaves genuine headroom rather than cutting it fine: the turn that
 * crosses the line still has to finish, and its remaining tool results land on
 * top of the measurement that triggered the check. Compressing at 95% would
 * routinely mean compressing *after* the window had already overflowed.
 */
export const AUTO_COMPACT_THRESHOLD_PERCENT = 85;

export interface AutoCompactInput {
	usedTokens: number;
	limit: number;
	messageCount: number;
	thresholdPercent?: number;
}

/**
 * Whether the conversation has crossed the line.
 *
 * Deliberately a pure predicate on the last measurement. The decision of *when*
 * to act on it belongs to the caller, and the answer is always "after the
 * current turn ends" - compressing mid-turn would reset the thread out from
 * under a tool loop that is still submitting results into it.
 */
export function shouldAutoCompact(input: AutoCompactInput): boolean {
	const threshold = input.thresholdPercent ?? AUTO_COMPACT_THRESHOLD_PERCENT;
	if (input.limit <= 0 || input.usedTokens <= 0) return false;
	// Nothing to gain from compressing a conversation that is barely started;
	// a huge single prompt is not a history problem.
	if (input.messageCount < 4) return false;
	return (input.usedTokens / input.limit) * 100 >= threshold;
}
