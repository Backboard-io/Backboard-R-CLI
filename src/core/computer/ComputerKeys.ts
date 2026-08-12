import type { ComputerKey, KeyModifier, KeyName } from "./ComputerTypes.ts";

export interface NormalizedComputerKey {
	key: KeyName;
	modifiers: KeyModifier[];
}

export function normalizeComputerKey(key: ComputerKey): NormalizedComputerKey {
	if (typeof key !== "string") {
		return {
			key: normalizeKeyName(key.key),
			modifiers: dedupeModifiers((key.modifiers ?? []).map(normalizeModifier)),
		};
	}

	const parts = key
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	const rawKey = parts.pop();
	if (!rawKey) throw new Error("Key cannot be empty");
	return {
		key: normalizeKeyName(rawKey),
		modifiers: dedupeModifiers(parts.map(normalizeModifier)),
	};
}

function normalizeModifier(value: string): KeyModifier {
	switch (value.toLowerCase()) {
		case "cmd":
		case "command":
		case "meta":
		case "win":
		case "windows":
			return "meta";
		case "ctrl":
		case "control":
			return "control";
		case "alt":
		case "option":
			return "alt";
		case "shift":
			return "shift";
		default:
			throw new Error(`Unsupported key modifier: ${value}`);
	}
}

function normalizeKeyName(value: string): KeyName {
	const key = value.toUpperCase();
	switch (key) {
		case "RETURN":
			return "ENTER";
		case "ESCAPE":
			return "ESC";
		case "DEL":
			return "DELETE";
		case "BACKSPACE":
			return "BACKSPACE";
		default:
			return key;
	}
}

function dedupeModifiers(modifiers: KeyModifier[]): KeyModifier[] {
	return [...new Set(modifiers)];
}
