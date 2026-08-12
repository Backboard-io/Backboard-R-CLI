import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const todoWrite: PromptModule = definePrompt(
	buildTodoWritePrompt(),
	buildTodoWritePrompt,
);

function buildTodoWritePrompt(context: PromptContext = {}): string {
	const head = `Draft and maintain a structured todo list for the current coding session. It organizes multi-step work, makes progress visible, and keeps the user informed of status and overall progress.

## Limits
- Up to 50 todo items.
- Up to 500 characters per item.

## Input format
Pass \`todos\` as an array of objects. Each object needs:
- \`content\`: a specific task description.
- \`status\`: one of \`pending\`, \`in_progress\`, or \`completed\`.

\`\`\`json
{
  "todos": [
    { "content": "First task that is done", "status": "completed" },
    { "content": "Currently working on this", "status": "in_progress" },
    { "content": "Not started yet", "status": "pending" }
  ]
}
\`\`\`

Item order follows array position.`;

	const tail = `## When to use this tool
Use it proactively when:
1. Work spans 3 or more distinct actions (at least 3 tool calls, not 3 logical steps folded into one command).
2. The work is non-trivial and needs deliberate planning or several operations.
3. The user explicitly asks for a todo list.
4. The user hands you multiple tasks (a numbered or comma-separated list).
5. New instructions arrive; capture them as todos immediately.
6. You start a task; mark it in_progress before you begin, and keep only one in_progress at a time.
7. You finish a task; mark it completed only after verifying, then add any follow-ups you discovered.
8. You hand control back to the user; mark all finished work completed first.

## When NOT to use this tool
Skip it in these cases:
1. There is a single, straightforward task.
2. The work is trivial and tracking adds nothing.
3. It takes fewer than 3 trivial steps; if 1-2 tool calls cover it, skip TodoWrite.
4. The request is purely conversational or informational.
5. You would be inventing todos from system context, environment output, or your own guesses; track only the tasks the user actually gave.
NOTE: for a single trivial task, just do it instead of listing it.

## Examples: when to use a todo list
<example>
User: Add authentication to my API: signup, login, password reset, and email verification.
Assistant: I'll lay these out as todos before writing code.
*Creates one item per capability plus the shared plumbing (user model, token handling), following the project's patterns*
Assistant: Starting with the user model and the signup endpoint.
<reasoning>
Why a todo list:
1. Four related but distinct features arrive in one request.
2. Each needs its own endpoints, validation, and tests.
3. A list keeps the shared plumbing and per-feature work in sync.
</reasoning>
</example>

<example>
User: Users hit intermittent 500s during checkout. Track it down and fix it.
Assistant: Let me reproduce it and trace the failure first, then track the fixes.
*Reproduces the error, reads logs and stack traces, inspects the checkout path and its dependencies*
*Creates todos: 1) Guard the null case in the tax calculator, 2) Retry the flaky payment webhook, 3) Fix the race in inventory reservation, 4) Add a regression test*
Assistant: Fixing the tax calculator guard first.
<reasoning>
Why a todo list:
1. The real scope is unknown until the investigation finishes.
2. The root cause turns out to be several independent bugs.
3. A list ensures each fix and its test actually ship.
</reasoning>
</example>

<example>
User: Migrate every API route from callbacks to async/await.
Assistant: First I'll find all the routes still using callbacks.
*Greps the routes directory*
Assistant: 23 routes across 11 files still use callbacks. I'll track each file as a todo.
*Adds one item per file*
<reasoning>
Why a todo list:
1. The grep fixes the scope up front.
2. Many near-identical edits are easy to lose track of.
3. Per-file items guarantee none is skipped or left half-migrated.
</reasoning>
</example>

<example>
User: Add a CSV export button to the reports page, and make sure lint, types, and tests all pass before you're done.
Assistant: On it. Setting up a todo list first.
*Creates todos:*
1. Add the export button and handler to the reports page
2. Implement CSV serialization for the report data
3. Wire up the download response
4. Run lint, typecheck, and tests; fix anything that fails
*Starts task 1*
<reasoning>
Why a todo list:
1. The feature spans UI, serialization, and response wiring.
2. The user named explicit gates (lint, types, tests) to satisfy.
3. Capturing those gates as a step keeps them from being forgotten.
</reasoning>
</example>

<example>
User: First run "npm run lint:fix", then "pytest tests/ -v --cov=src", then "docker build -t myapp:latest ."
Assistant: I'll capture these exact commands and begin.
*IN PARALLEL: creates the todos AND runs the first command*
Todos:
1. Run: npm run lint:fix
2. Run: pytest tests/ -v --cov=src
3. Run: docker build -t myapp:latest .
<reasoning>
Why this approach:
1. Three sequential commands mean at least three tool calls, so TodoWrite fires alongside the first command.
2. [IMPORTANT] Each command is stored verbatim, with every flag and argument intact.
3. Running the list and the first command together saves a round trip.
</reasoning>
</example>

## Examples: when not to use a todo list
<example>
User: What's the difference between git merge and git rebase?
Assistant: Merge preserves both histories and adds a merge commit; rebase replays your commits onto the target for a linear history. Rebase rewrites commit hashes, so avoid it on shared branches.
<reasoning>
No todo list: a conceptual explanation with no code to change.
</reasoning>
</example>

<example>
User: How do I reverse a list in Python?
Assistant: Slice it:
python
reversed_list = my_list[::-1]
Or call my_list.reverse() to reverse it in place.
<reasoning>
No todo list: one trivial step, nothing to track.
</reasoning>
</example>

<example>
User: Rename the variable temp to elapsedMs in timer.ts.
Assistant: Sure, renaming it now.
* Uses the Edit tool to rename the variable *
<reasoning>
No todo list: a single, localized edit.
</reasoning>
</example>

<example>
User: Run the test suite and tell me whether it passes.
Assistant: Running it now…
*Executes the test command*
All 128 tests pass.
<reasoning>
No todo list: one command with an immediate result and nothing to sequence.
</reasoning>
</example>

## Task states and management
1. States:
   - pending: not started.
   - in_progress: actively working (only ONE at a time).
   - completed: finished.
2. Managing tasks:
   - Update status in real time as you work.
   - Mark an item completed the moment you finish it; do not batch updates.
   - Mark completed only after you actually did the work (ran the tools, made the changes); never based on intent.
   - Keep exactly one item in_progress at any moment.
   - Finish the current item before starting the next.
   - Drop items that stop being relevant.
   - When you call TodoWrite alongside action tools, mark the first item in_progress; parallel execution means work has begun.
3. Completion rules:
   - Mark completed only when the item is fully done and verified.
   - Update immediately after each item.
   - If an error or blocker remains, keep the item in_progress.
   - When blocked, add a new item describing the blocker and its resolution.
   - Never mark completed when:
     - Tests fail.
     - The implementation is partial.
     - Errors are unresolved.
     - Required files or dependencies are missing.
4. Writing items:
   - Make each item specific and actionable.
   - Split large work into smaller steps.
   - Use clear, descriptive names.
   - Capture user-provided commands and steps verbatim, with every flag, argument, and the original order.
   - Example: "Run: npm test --coverage --watch=false".

**CRITICAL**: whenever the list has any pending items, exactly one item must be in_progress. When all work is done and only a "waiting for user" item remains, mark that one in_progress rather than pending, or drop the list entirely.

When in doubt, use this tool. Proactive tracking shows diligence and helps you cover every requirement.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`todos\` | \`array\` | yes | The updated todo list as an array of { content, status } objects |`;

	return [head, performanceTip(context), tail]
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function performanceTip(context: PromptContext): string {
	const tools = [
		hasTool(context, "Read") ? "Read" : "",
		hasTool(context, "Grep") ? "Grep" : "",
	].filter(Boolean);
	if (tools.length === 0) return "";
	const examples = [
		hasTool(context, "Grep") && hasTool(context, "Glob")
			? "- Build the initial todo list WHILE searching for relevant files with Grep/Glob."
			: "",
		hasTool(context, "Read") && hasTool(context, "Edit")
			? "- Set a todo to in_progress WHILE reading the file you are about to edit."
			: "",
	].filter(Boolean);
	const exampleBlock =
		examples.length > 0
			? `\n\nExamples of parallel execution:\n${examples.join("\n")}`
			: "";
	return `## PERFORMANCE TIP
Call TodoWrite IN PARALLEL with your other tools to save time and tokens. As you start a task, create or update todos in the same turn as your first exploration tools (${tools.join(", ")}, etc.). Do not wait until you finish reading files to build the list; do both together. This meaningfully cuts response time.${exampleBlock}`;
}
