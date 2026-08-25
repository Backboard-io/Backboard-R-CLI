export const DEFAULT_AGENT_MAX_DEPTH = 2;

/** Concurrent top-level sub-agent runs; excess spawns queue. */
export const DEFAULT_AGENT_MAX_CONCURRENT = 8;

export const NON_DELEGATABLE_AGENT_TOOLS: ReadonlySet<string> = new Set([
	"ask_user",
	"browser",
	"computer",
]);
