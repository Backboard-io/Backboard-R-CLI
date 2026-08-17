export const DEFAULT_AGENT_MAX_DEPTH = 2;

/**
 * Concurrent sub-agent runs across all depths; excess spawns queue. Must stay
 * >= DEFAULT_AGENT_MAX_DEPTH, since a nested chain holds one permit per level
 * (AgentTool enforces this).
 */
export const DEFAULT_AGENT_MAX_CONCURRENT = 8;

export const NON_DELEGATABLE_AGENT_TOOLS: ReadonlySet<string> = new Set([
	"ask_user",
	"browser",
	"computer",
]);
