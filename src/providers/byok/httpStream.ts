import type { ByokProviderId } from "../../core/keys/ProviderKeyTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import { readSseFrames, sseDataPayload } from "../backboard/sse.ts";
import { ByokError, providerErrorMessage } from "./ByokError.ts";

export interface ProviderRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	signal?: AbortSignal;
	provider: ByokProviderId;
}

async function send(request: ProviderRequest): Promise<Response> {
	const options: RequestInit = {
		method: "POST",
		headers: { "Content-Type": "application/json", ...request.headers },
		body: JSON.stringify(request.body),
	};
	if (request.signal) options.signal = request.signal;
	return fetch(request.url, options);
}

async function assertOk(
	res: Response,
	provider: ByokProviderId,
): Promise<void> {
	if (res.ok) return;
	const text = await res.text().catch(() => "");
	const body = safeJson(text);
	const detail = providerErrorMessage(body);
	throw new ByokError(
		detail
			? `${providerLabel(provider)} request failed (HTTP ${res.status}): ${detail}`
			: `${providerLabel(provider)} request failed: HTTP ${res.status}`,
		provider,
		res.status,
		body,
	);
}

/** GETs JSON with the provider's auth headers. */
export async function getJson<T>(
	url: string,
	headers: Record<string, string>,
	provider: ByokProviderId,
	signal?: AbortSignal,
): Promise<T> {
	const options: RequestInit = { method: "GET", headers };
	if (signal) options.signal = signal;
	const res = await fetch(url, options);
	await assertOk(res, provider);
	return (await res.json()) as T;
}

/**
 * POSTs JSON and yields each SSE frame's decoded payload. Frames with no
 * `data:` line, and the `[DONE]` sentinel OpenAI sends, are skipped so adapters
 * only ever see real events.
 */
export async function* postSseJson(
	request: ProviderRequest,
): AsyncIterable<Record<string, unknown>> {
	const res = await send(request);
	await assertOk(res, request.provider);
	if (!res.body) {
		throw new ByokError(
			`${providerLabel(request.provider)} stream response had no body`,
			request.provider,
			res.status,
			null,
		);
	}

	for await (const frame of readSseFrames(res.body)) {
		const data = sseDataPayload(frame);
		if (data === null) continue;
		// Matched against the extracted payload, never the raw frame: the payload
		// is JSON, so an assistant message that merely *contains* "data: [DONE]"
		// (writing about SSE, say) would otherwise end the stream mid-turn and
		// commit the partial turn as complete.
		if (data === "[DONE]") return;
		let payload: unknown;
		try {
			payload = JSON.parse(data);
		} catch (err) {
			throw new ByokError(
				`Malformed ${providerLabel(request.provider)} stream event: ${errorMessage(
					err,
				)}`,
				request.provider,
				0,
				frame,
			);
		}
		if (payload == null) continue;
		if (typeof payload === "object" && !Array.isArray(payload)) {
			yield payload as Record<string, unknown>;
		}
	}
}

function providerLabel(provider: ByokProviderId): string {
	switch (provider) {
		case "anthropic":
			return "Anthropic";
		case "openai":
			return "OpenAI";
		case "google":
			return "Google";
	}
}

export function safeJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
