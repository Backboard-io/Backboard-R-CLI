/**
 * Strips terminal control sequences from untrusted text so tool output and
 * model text can't drive the user's terminal (SGR spoofing, OSC 52 clipboard
 * writes, title changes, cursor games). Applied at the rendering leaves that
 * echo raw text into UI strings — input summaries, output previews, execute
 * titles, AskUser prompts — not to full transcript bodies, which Ink renders
 * as plain text nodes.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ST = String.fromCharCode(0x9c);
const CSI_C1 = String.fromCharCode(0x9b);

const STRING_TERMINATOR = `(?:${BEL}|${ESC}\\\\|${ST})`;

// The payload cap keeps an unterminated `ESC ]` local: without it, a malformed
// prefix would lazily swallow legitimate text up to a BEL/ST anywhere later in
// the buffer. An overlong or unterminated payload degrades to inert text via
// the CONTROL pass instead.
const OSC = new RegExp(
	`${ESC}\\][^${BEL}${ESC}]{0,4096}?${STRING_TERMINATOR}`,
	"g",
);
const STRING_ESCAPE = new RegExp(
	`${ESC}[P^_X][\\s\\S]*?(?:${ESC}\\\\|${ST})`,
	"g",
);
// C1 CSI (0x9b) is followed directly by parameters — no `[` — so it gets its
// own alternation with the bracket optional.
const CSI = new RegExp(`(?:${ESC}\\[|${CSI_C1}\\[?)[0-?]*[ -/]*[@-~]`, "g");
const SHORT_ESCAPE = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
const CONTROL = new RegExp(
	`[${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(
		0x0b,
	)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(
		0x9f,
	)}]`,
	"g",
);

/**
 * Removes ANSI escape sequences but keeps other control characters (\r, \t)
 * intact — for callers that still need to split on carriage returns. Not a
 * security boundary on its own; use sanitizeForTerminal for untrusted text
 * headed to the user's terminal.
 */
export function stripAnsi(value: string): string {
	return value
		.replace(OSC, "")
		.replace(STRING_ESCAPE, "")
		.replace(CSI, "")
		.replace(SHORT_ESCAPE, "");
}

export function sanitizeForTerminal(value: string): string {
	// CONTROL must run LAST: it strips 0x1b/0x9b themselves and is the backstop
	// for any unterminated or malformed sequence the structured passes above
	// didn't match — a reorder would let those survive.
	return stripAnsi(value).replace(CONTROL, "");
}
