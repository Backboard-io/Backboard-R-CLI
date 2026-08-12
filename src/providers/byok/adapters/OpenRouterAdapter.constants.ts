export const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
export const OPENROUTER_APP_TITLE = "Backboard R-CLI";
export const OPENROUTER_APP_URL = "https://backboard.io";
export const OPENROUTER_CATALOG_TTL_MS = 5 * 60 * 1000;

export const OPENROUTER_REQUIRED_MODEL_PARAMETERS = ["tools"] as const;
export const OPENROUTER_REASONING_PARAMETERS = [
	"reasoning",
	"include_reasoning",
] as const;
