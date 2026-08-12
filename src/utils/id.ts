import { randomUUID } from "node:crypto";

export function uuid(): string {
	return randomUUID();
}

export function shortId(prefix = ""): string {
	const id = randomUUID().replace(/-/g, "").slice(0, 8);
	return prefix ? `${prefix}_${id}` : id;
}

let counter = 0;
export function nextSequence(): number {
	return counter++;
}
