export const MAX_SUBAGENT_TOOL_ROUNDS = 20;

const REPORT_CONTRACT = `You cannot ask the user anything. Work with the tools you have, then stop.
Finish with a single concise final message that is your report: the parent receives that message and nothing else. Do not narrate your process.`;

/**
 * A custom agent's markdown body defines its role; the contract the runner
 * depends on is appended so it cannot be dropped by overriding the prompt.
 */
export function subAgentSystemPrompt(body: string): string {
	return `${body.trim()}\n\n${REPORT_CONTRACT}`;
}

/** Ceiling on the post-timeout summary turn, so expiry stays bounded. */
export const SUBAGENT_TIMEOUT_SUMMARY_MS = 15_000;

export const HANDED_OFF_REPORT =
	"Budget expired while the sub-agent was still working, so it moved to the background rather than losing its progress.";

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
