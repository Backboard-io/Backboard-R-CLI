export const OPENAI_NON_CHAT_MODEL_PATTERNS = [
	"embedding",
	"whisper",
	"tts",
	"dall-e",
	"moderation",
	"audio",
	"realtime",
	"image",
	"transcribe",
	"search",
	"computer-use",
	"codex",
] as const;

export const OPENAI_DISABLED_TOOL_REASONING_PATTERN = /^gpt-5\.[456](?:$|-)/;
