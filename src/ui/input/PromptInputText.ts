const WORD_CHARACTER_RE = /[\p{L}\p{N}_]/u;
const WHITESPACE_RE = /\s/;

export function normalizePromptInputText(text: string): string {
	if (text.length === 1 && isPromptInputCharacter(text)) return text;

	let normalized = "";
	for (const char of text.replace(/\r\n?/g, "\n")) {
		const nextChar = char === "\t" ? " " : char;
		if (isPromptInputCharacter(nextChar)) normalized += nextChar;
	}
	return normalized;
}

export function isPromptInputWordCharacter(char: string | undefined): boolean {
	return Boolean(char && WORD_CHARACTER_RE.test(char));
}

export function isPromptInputWhitespace(char: string | undefined): boolean {
	return Boolean(char && WHITESPACE_RE.test(char));
}

function isPromptInputCharacter(char: string): boolean {
	const code = char.charCodeAt(0);
	return code === 10 || (code >= 32 && code !== 127);
}
