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
	return `Use this tool to draft and maintain a structured todo list for the current coding session. It helps organize multi-step work, make progress visible, and keep the user informed.

## Limits

- Maximum 50 todo items
- Maximum 500 characters per todo item

## Input Format

Pass \`todos\` as an array of objects. Each object must contain:
- \`content\`: a specific task description string.
- \`status\`: one of \`pending\`, \`in_progress\`, or \`completed\`.

Example:

\`\`\`json
{
  "todos": [
    { "content": "Inspect project structure", "status": "completed" },
    { "content": "Implement the required behavior", "status": "in_progress" },
    { "content": "Run validators", "status": "pending" }
  ]
}
\`\`\`

Do not pass numbered strings, objects with numeric keys, or markdown checklist text.

${parallelTip(context)}

## When to Use This Tool

Use this tool proactively when:
1. Complex multi-step work requires 3 or more distinct actions - at least 3 tool calls, not 3 logical steps folded into one command.
2. Non-trivial work requires deliberate planning or multiple operations.
3. The user asks for a todo list.
4. The user gives multiple tasks (numbered or comma-separated).
5. New instructions arrive - capture them as todos immediately.
6. You begin a task - set it to in_progress before starting; only one in_progress at a time.
7. You finish a task - mark it completed only after verification, then add any follow-ups discovered.
8. You are handing back control to the user - mark all finished work completed first.

When uncertain, err on the side of using this tool.

## When NOT to Use This Tool

Skip it when:
1. There is a single, straightforward task - do it directly instead of creating a list.
2. The work is trivial and tracking adds no value.
3. 1-2 tool calls cover the whole task.
4. The request is purely conversational or informational.
5. The todos would come from system context, environment outputs, or your interpretation of what might need doing - track only tasks the user actually gave.

## Task States and Management

1. Task states:
- pending: not started
- in_progress: currently working, limit to one item
- completed: finished

2. Task management:
- Update status in real time; mark items completed immediately after finishing - do not batch.
- Mark completed only after the work was actually performed, never based on plans or intentions.
- Finish the current item before starting the next; remove items that become irrelevant.
- When calling TodoWrite in parallel with action tools, mark the first item in_progress - work has begun.

3. Completion rules:
- Mark completed only when fully done and verified.
- If errors or blockers remain, keep the item in_progress and add a blocker or resolution item.
- Never mark completed if tests fail, implementation is partial, errors are unresolved, or required files/dependencies are missing.

4. Task breakdown:
- Use specific, actionable items with clear, descriptive names.
- Split complex work into smaller steps.
- Capture user-provided commands and steps verbatim - every flag, argument, and the original order (e.g., "Run: npm test --coverage --watch=false").
- Include required validation as its own item.

CRITICAL: if your todo list has any pending items, you must have exactly one in_progress item. When all work is complete and only a waiting-for-user item remains, mark it in_progress (not pending) or remove the todo list entirely.`.trim();
}

function parallelTip(context: PromptContext): string {
	const tools = [
		hasTool(context, "Read") ? "Read" : "",
		hasTool(context, "Grep") ? "Grep" : "",
		hasTool(context, "Glob") ? "Glob" : "",
		hasTool(context, "Execute") ? "Execute" : "",
	].filter(Boolean);
	if (tools.length === 0) return "";
	return `## Performance Tip\n\nWhen starting work, update todos in parallel with available independent tools such as ${tools.join(", ")} when it is safe to do so. Do not parallelize writes to the same file or dependent operations.`;
}
