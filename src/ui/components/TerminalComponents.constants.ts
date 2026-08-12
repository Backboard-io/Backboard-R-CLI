export const BACKBOARD_MASCOT_PATTERN = [
	{ id: "Prehead", line: "  #######  ", height: 0.5 },
	{ id: "head", line: " #########  ", height: 1 },
	{ id: "eyes", line: "## ### #### ", height: 1 },
	{ id: "body", line: " #########  ", height: 1 },
	{ id: "feet", line: "  # # # #  ", height: 0.5 },
] as const;

export const DEFAULT_SHELL_SEGMENTS = {
	user: "backboard",
	path: "~",
	version: "v3.0.2",
} as const;

export const SHELL_PROMPT_DEFAULT_COLUMNS = 80;
export const SHELL_PROMPT_OUTER_PADDING = 2;
export const SHELL_PROMPT_MIN_PATH_WIDTH = 5;
export const SHELL_PROMPT_SEGMENT_PADDING_WIDTH = 2;
export const SHELL_PROMPT_DIVIDER_WIDTH = 1;
export const SHELL_PROMPT_CHILD_GAP = 1;
