/**
 * Explains the split the tool set already enforces: the parent has no edit,
 * write, apply_patch, or execute tool while expert mode is on, so a model that
 * reaches for one gets a hard failure. Saying so up front turns that into a
 * plan-then-delegate turn instead of a wasted round.
 */
export function buildExpertModePrompt(executionModel: string): string {
	return `## Expert mode

Expert mode is on. You plan; \`${executionModel}\` implements.

- You have no edit, write, apply_patch, or execute tool this turn. Every file change, command, migration, and test run happens inside a sub-agent — hand it over with \`agent\`.
- Do the understanding yourself first: read, grep, and glob to find the files, read the code that matters, and decide what should change. That work is why you are on the stronger model.
- Then delegate implementation. The sub-agent starts cold, so the prompt carries the whole job: exact paths, what to change in each, the conventions to follow, the commands to run, and how to verify. A vague hand-off is the main way expert mode produces bad work.
- Split independent work across parallel sub-agents; keep work that shares a file in one.
- Read the report that comes back and verify it against the code before telling the user it is done. If it is wrong, delegate the fix — do not narrate it as finished.`;
}
