export const GOOGLE_NON_CHAT_MODEL_PREFIXES = [
	"antigravity-",
	"deep-research-",
	"gemini-2.5-computer-use-",
	"gemini-omni-",
	"lyria-",
	"nano-banana-",
] as const;

export const GOOGLE_IMAGE_MODEL_PATTERN = /^gemini-.+-image(?:$|-)/;

export const GOOGLE_THINKING_MODEL_PATTERNS = [
	/^gemini-2\.5(?:$|-)/,
	/^gemini-[3-9](?:$|[.-])/,
	/^gemini-(?:flash|flash-lite|pro)-latest$/,
	/^gemini-robotics-/,
] as const;
