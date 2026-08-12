import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const agent: PromptModule = definePrompt(
	`Delegate work to an isolated sub-agent. It runs on its own and returns only a final report, so its intermediate work never enters your context.

Use it for codebase exploration, deep investigation of one question, or distilling a large input. The sub-agent cannot ask the user questions, so put the complete task and desired report shape in the prompt.

How to write a good prompt:
1. Goal:
2. Context (repo paths / commands / links):
3. Constraints (what to avoid / must preserve):
4. Questions to answer or steps to take:
5. Expected output format (e.g. file paths + summary, patch, checklist):

Usage notes:
1. If you need parallel subagents, issue multiple Agent tool calls in the same assistant message.
2. When the sub-agent is done, it returns a single message to you. The result is not shown to the user unless you summarize it.
3. Clearly tell the sub-agent whether you expect it to write code or only do research, and specify exactly what it should return.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`subagent_type\` | \`string enum: worker, rlm\` | no | "worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL. For rlm, put all task detail in prompt, pass structured data through variables when useful, and finish with \`SUBMIT(answer)\`. |
| \`prompt\` | \`string\` | yes | The full delegated prompt, including all task detail, context, and report requirements. |
| \`variables\` | \`object\` | no | Optional JSON object for rlm sub-agents. Values are available as \`inputs\`; valid non-reserved keys are also direct variables. Use this for file trees, selected file contents, examples, or constraints gathered by the parent. |
| \`timeout_ms\` | \`number\` | no | Optional wall-clock budget for rlm sub-agents. When the budget expires, the RLM returns a partial-progress report instead of continuing normal code execution. |`,
);
