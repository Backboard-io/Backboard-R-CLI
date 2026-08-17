export const MAX_SUBAGENT_TOOL_ROUNDS = 20;

/** Ceiling on the post-timeout summary turn, so expiry stays bounded. */
export const SUBAGENT_TIMEOUT_SUMMARY_MS = 15_000;

export const TIMED_OUT_WITHOUT_REPORT =
	"(the sub-agent ran out of time before producing a report)";

export function timeoutSummaryPrompt(definition: { name: string }): string {
	return `Your time budget expired before you finished this task.

Report now, using only what you already established:
- What you found, with file paths.
- What you did not get to.
- Any files you modified.

Do not start new work. This is your final message as the "${definition.name}" sub-agent.`;
}
