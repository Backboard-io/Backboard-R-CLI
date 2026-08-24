import type { ComputerKey, KeyModifier } from "./ComputerTypes.ts";

export interface NormalizedComputerKey {
	key: string;
	modifiers: KeyModifier[];
}

/** Key names the platforms understand, in canonical upper-case form. */
export const CANONICAL_KEY_NAMES: readonly string[] = [
	"ENTER",
	"TAB",
	"SPACE",
	"ESC",
	"BACKSPACE",
	"DELETE",
	"UP",
	"DOWN",
	"LEFT",
	"RIGHT",
	"HOME",
	"END",
	"PAGEUP",
	"PAGEDOWN",
	"INSERT",
	"CAPSLOCK",
	"F1-F12",
];

const KEY_ALIASES: Record<string, string> = {
	RETURN: "ENTER",
	KP_ENTER: "ENTER",
	ESCAPE: "ESC",
	DEL: "DELETE",
	FORWARDDELETE: "DELETE",
	BACK: "BACKSPACE",
	BKSP: "BACKSPACE",
	PGUP: "PAGEUP",
	PGDN: "PAGEDOWN",
	PRIOR: "PAGEUP",
	NEXT: "PAGEDOWN",
	ARROWUP: "UP",
	ARROWDOWN: "DOWN",
	ARROWLEFT: "LEFT",
	ARROWRIGHT: "RIGHT",
	SPACEBAR: "SPACE",
	CAPS_LOCK: "CAPSLOCK",
	PAGE_UP: "PAGEUP",
	PAGE_DOWN: "PAGEDOWN",
	BACK_SPACE: "BACKSPACE",
	PLUS: "=",
	MINUS: "-",
	COMMA: ",",
	PERIOD: ".",
	SLASH: "/",
	BACKSLASH: "\\",
	SEMICOLON: ";",
	APOSTROPHE: "'",
	QUOTE: "'",
	GRAVE: "`",
	BRACKETLEFT: "[",
	BRACKETRIGHT: "]",
	EQUAL: "=",
};

/**
 * Accepts every common spelling of a key: `{key, modifiers}` objects, chord
 * strings such as `ctrl+shift+t` or `cmd+s`, xdotool names (`Return`,
 * `ctrl`, `super`), and single characters. Returns the canonical form the
 * platforms consume.
 */
export function normalizeComputerKey(key: ComputerKey): NormalizedComputerKey {
	if (typeof key !== "string") {
		const parsed = parseChord(key.key);
		return {
			key: parsed.key,
			modifiers: dedupeModifiers([
				...parsed.modifiers,
				...(key.modifiers ?? []).map(normalizeModifier),
			]),
		};
	}
	const parsed = parseChord(key);
	return { key: parsed.key, modifiers: dedupeModifiers(parsed.modifiers) };
}

function parseChord(value: string): NormalizedComputerKey {
	const trimmed = value.trim();
	if (!trimmed) throw new Error("Key cannot be empty");
	// A literal "+" key (or "ctrl++") ends with a plus that is not a separator.
	const parts = trimmed.endsWith("+")
		? [...trimmed.slice(0, -1).split("+"), "+"]
		: trimmed.split("+");
	const cleaned = parts.map((part) => part.trim()).filter(Boolean);
	const rawKey = cleaned.pop();
	if (!rawKey) throw new Error("Key cannot be empty");
	const modifiers: KeyModifier[] = [];
	const extras: string[] = [];
	for (const part of cleaned) {
		const modifier = tryNormalizeModifier(part);
		if (modifier) modifiers.push(modifier);
		else extras.push(part);
	}
	if (extras.length > 0) {
		throw new Error(`Unsupported key modifier: ${extras[0]}`);
	}
	return { key: normalizeKeyName(rawKey), modifiers };
}

function tryNormalizeModifier(value: string): KeyModifier | null {
	switch (value.toLowerCase()) {
		case "cmd":
		case "command":
		case "meta":
		case "super":
		case "win":
		case "windows":
			return "meta";
		case "ctrl":
		case "control":
			return "control";
		case "alt":
		case "option":
		case "opt":
			return "alt";
		case "shift":
			return "shift";
		default:
			return null;
	}
}

export function normalizeModifier(value: string): KeyModifier {
	const modifier = tryNormalizeModifier(value);
	if (!modifier) throw new Error(`Unsupported key modifier: ${value}`);
	return modifier;
}

export function normalizeKeyName(value: string): string {
	if (value.length === 1) return value.toUpperCase();
	const upper = value.toUpperCase().replaceAll(" ", "");
	return KEY_ALIASES[upper] ?? upper;
}

function dedupeModifiers(modifiers: KeyModifier[]): KeyModifier[] {
	return [...new Set(modifiers)];
}

/** Human-readable chord, e.g. `ctrl+shift+T`, for summaries. */
export function formatComputerKey(key: NormalizedComputerKey): string {
	return [...key.modifiers, key.key].join("+");
}
