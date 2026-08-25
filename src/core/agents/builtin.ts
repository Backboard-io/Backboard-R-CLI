import { subagent } from "../../prompts/system/subagent.tsx";
import type { AgentDefinition } from "./AgentDefinition.ts";

export const WORKER_AGENT_NAME = "worker";
export const RLM_AGENT_NAME = "rlm";

/**
 * The two modes that existed before the registry. They stay built in so
 * `subagent_type` keeps accepting them when no agent files are present.
 */
export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
	{
		name: WORKER_AGENT_NAME,
		description:
			"Tool-using sub-agent that works over the project and returns a report.",
		mode: "worker",
		systemPrompt: subagent.prompt,
		source: "built-in",
	},
	{
		name: RLM_AGENT_NAME,
		description:
			"Analyzes the prompt and provided variables in a JavaScript REPL.",
		mode: "rlm",
		systemPrompt: "",
		source: "built-in",
	},
];
