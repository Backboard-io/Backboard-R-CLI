import { randomUUID } from "node:crypto";

export function uuid(): string {
	return randomUUID();
}

export function shortId(prefix = ""): string {
	const id = randomUUID().replace(/-/g, "").slice(0, 8);
	return prefix ? `${prefix}_${id}` : id;
}

export function isShortId(value: string, prefix: string): boolean {
	const expectedPrefix = `${prefix}_`;
	return (
		value.length === expectedPrefix.length + 8 &&
		value.startsWith(expectedPrefix) &&
		/^[0-9a-f]{8}$/.test(value.slice(expectedPrefix.length))
	);
}

export function isSessionId(value: string): boolean {
	return isShortId(value, "sess");
}

export function isByokThreadId(value: string): boolean {
	return isShortId(value, "byok");
}

let counter = 0;
export function nextSequence(): number {
	return counter++;
}
