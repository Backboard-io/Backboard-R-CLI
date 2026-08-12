const BUILTIN_AGENT_NAMES: Record<string, string> = {
	Read: "read",
	Write: "write",
	Edit: "edit",
	Create: "create",
	ApplyPatch: "apply_patch",
	Execute: "execute",
	Grep: "grep",
	Glob: "glob",
	FetchUrl: "fetch_url",
	WebSearch: "web_search",
	AskUser: "ask_user",
	TodoWrite: "todo_write",
	Computer: "computer",
	Browser: "browser",
	Agent: "agent",
	FindSkill: "find_skill",
	FindMcp: "find_mcp",
};

const BUILTIN_DISPLAY_NAMES = new Map(
	Object.entries(BUILTIN_AGENT_NAMES).map(([displayName, agentName]) => [
		agentName,
		displayName,
	]),
);

export function toAgentToolName(name: string): string {
	return BUILTIN_AGENT_NAMES[name] ?? name;
}

export function toDisplayToolName(name: string): string {
	return BUILTIN_DISPLAY_NAMES.get(name) ?? name;
}

export function canonicalToolName(name: string): string {
	const agentName = BUILTIN_AGENT_NAMES[name];
	if (agentName) return agentName;
	return name;
}
