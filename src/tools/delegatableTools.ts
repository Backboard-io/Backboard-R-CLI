import type { AgentDefinition } from "../core/agents/AgentDefinition.ts";
import { canonicalToolName } from "../core/tools/names.ts";
import type { Tool } from "../core/tools/Tool.ts";
import { NON_DELEGATABLE_AGENT_TOOLS } from "./AgentToolConstants.ts";

export interface SelectDelegatableToolsOptions {
	definition: AgentDefinition;
	/** Tools already narrowed by the session's ToolPolicy. */
	candidates: readonly Tool[];
	/** The Agent tool itself; omitted when nesting is unavailable. */
	agentTool?: Tool;
	isToolEnabled: (name: string) => boolean;
}

/**
 * Narrows the parent's tool set to what a sub-agent may call: always-blocked
 * tools drop out, then the definition's allow/deny lists apply. A definition
 * that pins `tools` must name the Agent tool to keep spawning sub-agents.
 */
export function selectDelegatableTools({
	definition,
	candidates,
	agentTool,
	isToolEnabled,
}: SelectDelegatableToolsOptions): Tool[] {
	const allowed = nameSet(definition.tools);
	const denied = nameSet(definition.disallowedTools);
	const permits = (name: string): boolean =>
		(!allowed || allowed.has(name)) && !denied?.has(name);

	const tools: Tool[] = [];
	for (const tool of candidates) {
		if (tool === agentTool) continue;
		if (NON_DELEGATABLE_AGENT_TOOLS.has(tool.agentName)) continue;
		if (!permits(tool.agentName)) continue;
		tools.push(tool);
	}

	if (
		agentTool &&
		permits(agentTool.agentName) &&
		isToolEnabled(agentTool.agentName)
	) {
		tools.push(agentTool);
	}
	return tools;
}

function nameSet(
	names: readonly string[] | undefined,
): Set<string> | undefined {
	return names ? new Set(names.map(canonicalToolName)) : undefined;
}
