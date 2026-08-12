import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const todoWrite: PromptModule = definePrompt(
	buildTodoWritePrompt(),
	buildTodoWritePrompt,
);

function buildTodoWritePrompt(context: PromptContext = {}): string {
	const explore = ["Read", "Grep", "Glob"].filter((tool) =>
		hasTool(context, tool),
	);
	const parallel =
		explore.length > 0
			? ` Create it in the same message as your first ${explore.map((t) => t.toLowerCase()).join("/")} calls rather than afterwards.`
			: "";
	return `Maintain the session's task list, which the user sees as your progress. Pass \`todos\` as an array of objects, each { content, status } with status pending, in_progress, or completed, holding the full updated list. Do not pass numbered strings, markdown checklists, or partial lists.

Use it when the work spans three or more distinct steps, when the user hands you several tasks at once, or when new instructions arrive mid-task. Skip it for one- or two-step requests and for plain questions.${parallel}
- Keep exactly one item in_progress while work remains. Mark an item completed the moment it is actually done and verified, never ahead of time and never in a batch at the end.
- Record commands the user gave you verbatim. Remove items that stop being relevant. If you are blocked, add an item for the blocker instead of closing the blocked task.
- Limits: 50 items, 500 characters each.`;
}
