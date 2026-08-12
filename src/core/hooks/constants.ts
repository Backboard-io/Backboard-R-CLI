export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
// Terminal hooks (Stop, SessionEnd) run during teardown; bound them so a slow
// hook cannot block turn completion or process exit.
export const TERMINAL_HOOK_TIMEOUT_MS = 5_000;
export const HOOK_HASH_PREFIX = "sha256:";
export const HOOK_ENV_PREFIX = "";
// Cap hook stdout/stderr (matches the Execute/Grep output cap).
export const MAX_HOOK_OUTPUT = 40_000;

export const HOOK_EVENT_NAMES = [
	"SessionStart",
	"UserPromptSubmit",
	"PreToolUse",
	"PostToolUse",
	"Stop",
	"SessionEnd",
] as const;

// Matchers only apply to tool events.
export function isToolHookEvent(
	event: (typeof HOOK_EVENT_NAMES)[number],
): boolean {
	return event === "PreToolUse" || event === "PostToolUse";
}

export const SAFE_HOOK_ENV_KEYS = [
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TERM",
	"SSH_AUTH_SOCK",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
] as const;
