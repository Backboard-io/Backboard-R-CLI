import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";

/**
 * A vendor API failure. Carries the HTTP status so `ProviderStreamConsumer`'s
 * retry classifier sees the same 502/503/504 signal it gets from Backboard,
 * and so auth failures can be reported with a "check /keys" hint.
 */
export class ByokError extends Error {
	constructor(
		message: string,
		readonly provider: ByokProviderId,
		readonly status: number,
		readonly body: unknown,
	) {
		super(message);
		this.name = "ByokError";
	}

	get isAuthFailure(): boolean {
		return this.status === 401 || this.status === 403;
	}
}

export function unexpectedStreamEndMessage(provider: ByokProviderId): string {
	const labels: Record<ByokProviderId, string> = {
		anthropic: "Anthropic",
		openai: "OpenAI",
		google: "Google",
		openrouter: "OpenRouter",
	};
	const label = labels[provider];
	return `${label} stream closed unexpectedly before a terminal event.`;
}

/** Extracts the human-readable message vendors bury at varying depths. */
export function providerErrorMessage(body: unknown): string | null {
	if (typeof body === "string" && body.trim()) return body.trim();
	if (typeof body !== "object" || body === null) return null;

	const record = body as Record<string, unknown>;
	const error = record.error ?? record;
	if (typeof error === "string" && error.trim()) return error.trim();
	if (typeof error === "object" && error !== null) {
		const message = (error as Record<string, unknown>).message;
		// OpenRouter wraps upstream failures as "Provider returned error" and
		// puts the vendor's actual message in metadata.raw.
		const metadata = (error as Record<string, unknown>).metadata;
		const raw =
			typeof metadata === "object" && metadata !== null
				? (metadata as Record<string, unknown>).raw
				: undefined;
		const detail =
			typeof raw === "string" && raw.trim()
				? (providerErrorMessage(parseMaybeJson(raw)) ?? raw.trim())
				: null;
		if (typeof message === "string" && message.trim()) {
			return detail && detail !== message.trim()
				? `${message.trim()}: ${detail}`
				: message.trim();
		}
		if (detail) return detail;
	}
	const message = record.message;
	return typeof message === "string" && message.trim() ? message.trim() : null;
}

function parseMaybeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
