import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const agent: PromptModule = definePrompt(
	buildAgentPrompt(),
	buildAgentPrompt,
);

function buildAgentPrompt(context: PromptContext = {}): string {
	const direct = [
		hasTool(context, "Read") ? "read a known file with read" : "",
		hasTool(context, "Grep") ? "find a known symbol with grep" : "",
	].filter(Boolean);
	const directLine =
		direct.length > 0
			? ` For small jobs, ${direct.join(" and ")} yourself.`
			: "";
	return `Hand a self-contained task to a sub-agent that works on its own and returns one final report; none of its intermediate steps enter your context.

Use it when a wide exploration would flood your context, when several independent investigations can run at the same time, or when a large input needs distilling to a few findings. Do not delegate work you can finish in a handful of calls, and do not use it to re-check your own work.${directLine}
- The sub-agent starts with no memory of this conversation and cannot ask the user anything. Give it the goal, the relevant paths, commands, and constraints, whether it may edit files or must only investigate, and the exact shape of report you want back.
- To run sub-agents in parallel, make several calls in one message. The user does not see the report; relay what they need.
- subagent_type picks which agent runs; see "Available agents". The default "worker" uses the project tools, while "rlm" analyzes the prompt and the \`variables\` object inside a JavaScript REPL and must finish by calling SUBMIT(answer); timeout_ms bounds how long it may run.`;
}
