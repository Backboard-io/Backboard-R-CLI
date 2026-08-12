export const MODIFIED_ENTER_SEQUENCES = [
	"[27;2;13~",
	"[27;2;10~",
	"[13;2u",
	"[10;2u",
	"[13;2~",
	"[10;2~",
	"\x1b[27;2;13~",
	"\x1b[27;2;10~",
	"\x1b[13;2u",
	"\x1b[10;2u",
	"\x1b[13;2~",
	"\x1b[10;2~",
] as const;

export const LARGE_PASTE_MIN_LINES = 8;
export const LARGE_PASTE_MIN_LENGTH = 800;
export const PASTE_PREVIEW_TEXT_LENGTH = 21;
