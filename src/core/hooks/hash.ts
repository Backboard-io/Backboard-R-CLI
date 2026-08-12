import { createHash } from "node:crypto";
import { HOOK_HASH_PREFIX } from "./constants.ts";
import type { CommandHookConfig, HookEventName } from "./types.ts";

export function hookDefinitionHash(input: {
	event: HookEventName;
	matcher?: string;
	hook: CommandHookConfig;
}): string {
	const digest = createHash("sha256")
		.update(stableStringify(input))
		.digest("hex");
	return `${HOOK_HASH_PREFIX}${digest}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	}
	// Codepoint order, not locale order: this digest is persisted (in
	// trustedProjectHookHashes), so ordering must not vary with runtime locale.
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
	);
	return `{${entries
		.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
		.join(",")}}`;
}
