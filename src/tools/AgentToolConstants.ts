export const DEFAULT_AGENT_MAX_DEPTH = 2;

export const NON_DELEGATABLE_AGENT_TOOLS: ReadonlySet<string> = new Set([
	"ask_user",
	"browser",
	"computer",
]);
