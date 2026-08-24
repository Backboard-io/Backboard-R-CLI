import { contextWindowFor } from "../../../core/context/ContextWindow.ts";
import type {
	ModelCatalogItem,
	ProviderEvent,
	ProviderToolCall,
} from "../../backboard/types.ts";
import { unexpectedStreamEndMessage } from "../ByokError.ts";
import type {
	ByokMessage,
	ByokStreamRequest,
	ProviderAdapter,
} from "../ByokTypes.ts";
import { toGoogleSchema } from "../googleSchema.ts";
import { getJson, postSseJson } from "../httpStream.ts";
import {
	thinkingBudgetTokens,
	thinkingLevel,
	usesNativeAdaptiveThinking,
} from "../thinking.ts";
import {
	planToolImages,
	renderToolResult,
	TOOL_IMAGE_NOTE,
} from "../toolImages.ts";
import {
	GOOGLE_IMAGE_MODEL_PATTERN,
	GOOGLE_NON_CHAT_MODEL_PREFIXES,
	GOOGLE_THINKING_MODEL_PATTERNS,
} from "./GoogleAdapter.constants.ts";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleModelsResponse {
	models?: Array<{
		name?: string;
		displayName?: string;
		supportedGenerationMethods?: string[];
	}>;
}

export const googleAdapter: ProviderAdapter = {
	id: "google",
	label: "Google Gemini",
	consoleUrl: "https://aistudio.google.com/app/apikey",
	keyHint: "AIza...",

	looksLikeKey(key) {
		return /^AIza[\w-]{30,}$/.test(key.trim());
	},

	async validateKey(key, signal) {
		await getJson<GoogleModelsResponse>(
			`${API_BASE}/models?pageSize=1`,
			headers(key),
			"google",
			signal,
		);
	},

	async listModels(key, signal) {
		const response = await getJson<GoogleModelsResponse>(
			`${API_BASE}/models?pageSize=1000`,
			headers(key),
			"google",
			signal,
		);
		const models: ModelCatalogItem[] = [];
		for (const model of response.models ?? []) {
			// Names come back namespaced as "models/gemini-...".
			const name = model.name?.replace(/^models\//, "");
			if (!name) continue;
			if (!model.supportedGenerationMethods?.includes("generateContent")) {
				continue;
			}
			if (!isGoogleChatModel(name)) continue;
			models.push({
				name,
				provider: "google",
				model_type: "llm",
				supports_thinking: supportsGoogleThinking(name),
				context_limit: contextWindowFor({ provider: "google", model: name }),
			});
		}
		return models;
	},

	supportsThinking(model) {
		return supportsGoogleThinking(model);
	},

	stream(request, key) {
		return streamGoogle(request, key);
	},
};

function headers(key: string): Record<string, string> {
	return { "x-goog-api-key": key.trim() };
}

export function isGoogleChatModel(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	if (/embedding|aqa/.test(normalized)) return false;
	if (GOOGLE_IMAGE_MODEL_PATTERN.test(normalized)) return false;
	return !GOOGLE_NON_CHAT_MODEL_PREFIXES.some((prefix) =>
		normalized.startsWith(prefix),
	);
}

export function supportsGoogleThinking(model: string): boolean {
	const normalized = model.trim().toLowerCase();
	return GOOGLE_THINKING_MODEL_PATTERNS.some((pattern) =>
		pattern.test(normalized),
	);
}

async function* streamGoogle(
	request: ByokStreamRequest,
	key: string,
): AsyncIterable<ProviderEvent> {
	const generationConfig: Record<string, unknown> = {};
	if (request.maxOutputTokens) {
		generationConfig.maxOutputTokens = request.maxOutputTokens;
	}
	const thinkingConfig = googleThinkingConfig(request);
	if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

	const body: Record<string, unknown> = {
		systemInstruction: { parts: [{ text: request.systemPrompt }] },
		contents: renderGoogleContents(request.messages),
	};
	if (Object.keys(generationConfig).length > 0) {
		body.generationConfig = generationConfig;
	}
	const declarations = toFunctionDeclarations(request);
	if (declarations.length > 0) {
		body.tools = [{ functionDeclarations: declarations }];
	}

	const calls: ProviderToolCall[] = [];
	let usage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
	};
	let callIndex = 0;
	let finishReason: string | null = null;

	const sseRequest: Parameters<typeof postSseJson>[0] = {
		url: `${API_BASE}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
		headers: headers(key),
		body,
		provider: "google",
	};
	if (request.signal) sseRequest.signal = request.signal;

	for await (const chunk of postSseJson(sseRequest)) {
		if (chunk.error) {
			const error = chunk.error as { message?: string };
			yield {
				kind: "failed",
				error: error.message ?? "Gemini returned an error event",
			};
			return;
		}

		const metadata = chunk.usageMetadata as Record<string, unknown> | undefined;
		if (metadata) usage = readUsage(metadata);

		// A prompt rejected outright comes back with no candidate at all.
		const blockReason = (
			chunk.promptFeedback as { blockReason?: string } | undefined
		)?.blockReason;
		if (blockReason) {
			yield { kind: "failed", error: blockedPromptMessage(blockReason) };
			return;
		}

		const candidate = (chunk.candidates as unknown[] | undefined)?.[0] as
			| { content?: { parts?: unknown[] }; finishReason?: string }
			| undefined;
		if (candidate?.finishReason) finishReason = candidate.finishReason;
		for (const part of candidate?.content?.parts ?? []) {
			if (typeof part !== "object" || part === null) continue;
			const entry = part as {
				text?: string;
				thought?: boolean;
				thoughtSignature?: string;
				functionCall?: { name?: string; args?: unknown; id?: string };
			};
			// Gemini streams reasoning as text parts flagged `thought`; those are
			// not answer text and must not reach the transcript.
			if (entry.text && !entry.thought) {
				yield { kind: "assistant_delta", text: entry.text };
			}
			if (entry.functionCall?.name) {
				// Gemini 3 ids its calls; older models do not, so mint one when it
				// is missing. Adopting the provider's id rather than always minting
				// keeps the pairing unambiguous when the model fires two calls of
				// the *same* tool in one round, where matching a result back by
				// name alone cannot tell them apart.
				const call: ProviderToolCall = {
					id: entry.functionCall.id ?? `gemini_call_${callIndex++}`,
					name: entry.functionCall.name,
					input: entry.functionCall.args ?? {},
					// Gemini 3 signs the part that holds a function call and rejects
					// the next request if the call comes back unsigned, so the token
					// has to survive the round-trip through the transcript.
					...(entry.thoughtSignature
						? { signature: entry.thoughtSignature }
						: {}),
				};
				calls.push(call);
				yield { kind: "tool_started", id: call.id, name: call.name };
				yield { kind: "tool_ready", call };
			}
		}
	}

	if (finishReason === null) {
		yield {
			kind: "failed",
			error: unexpectedStreamEndMessage("google"),
			retryable: true,
		};
		return;
	}

	const finalUsage = { ...usage, provider: "google", model: request.model };
	if (calls.length > 0) {
		yield { kind: "usage", usage: finalUsage };
		yield { kind: "requires_action", runId: null, calls };
		return;
	}
	// Anything but a normal stop ended the turn early. Without this the turn
	// completes empty and the user is left with a blank reply and no reason.
	const abnormal = abnormalFinishMessage(finishReason);
	if (abnormal) {
		yield {
			kind: "failed",
			error: abnormal,
			retryable: finishReason === "MAX_TOKENS",
		};
		return;
	}
	yield { kind: "completed", usage: finalUsage };
}

function blockedPromptMessage(reason: string): string {
	return `Gemini refused the request (${reason.toLowerCase()}).`;
}

/** `null` for a normal finish; a message for anything that cut the turn short. */
function abnormalFinishMessage(reason: string | null): string | null {
	switch (reason) {
		case null:
		case "STOP":
		case "FINISH_REASON_UNSPECIFIED":
			return null;
		case "MAX_TOKENS":
			return "Gemini hit its output limit before finishing its reply.";
		case "SAFETY":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "BLOCKLIST":
			return `Gemini stopped the reply (${reason.toLowerCase().replaceAll("_", " ")}).`;
		case "RECITATION":
			return "Gemini stopped the reply (it was reciting training data).";
		default:
			return `Gemini ended the reply early (${reason.toLowerCase()}).`;
	}
}

function readUsage(metadata: Record<string, unknown>): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cachedTokens: number;
} {
	return {
		inputTokens: numberOf(metadata.promptTokenCount),
		outputTokens: numberOf(metadata.candidatesTokenCount),
		totalTokens: numberOf(metadata.totalTokenCount),
		cachedTokens: numberOf(metadata.cachedContentTokenCount),
	};
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toFunctionDeclarations(request: ByokStreamRequest): unknown[] {
	return request.tools.map((tool) => {
		const parameters = toGoogleSchema(tool.function.parameters);
		return {
			name: tool.function.name,
			description: tool.function.description,
			...(parameters ? { parameters } : {}),
		};
	});
}

/**
 * Gemini has two thinking knobs and they are not interchangeable: Gemini 3 is
 * driven by a named `thinkingLevel`, earlier models by a `thinkingBudget` in
 * tokens. `thinkingLevel` tops out at "high" - the API rejects "max" outright.
 */
export function googleThinkingConfig(
	request: ByokStreamRequest,
): Record<string, unknown> | null {
	if (!request.thinking) return null;

	if (usesNativeAdaptiveThinking("google", request.model)) {
		const level = thinkingLevel(request.thinking);
		if (!level) return null;
		return { thinkingLevel: level === "max" ? "high" : level };
	}

	const budget = thinkingBudgetTokens(request.thinking, "google");
	return budget !== null && budget > 0 ? { thinkingBudget: budget } : null;
}

/**
 * Gemini alternates `user` and `model` turns and has no tool role: results go
 * back as `user` content holding `functionResponse` parts.
 */
export function renderGoogleContents(
	messages: readonly ByokMessage[],
): unknown[] {
	const out: unknown[] = [];
	// Names, not ids, key a functionResponse - resolve each result's name from
	// the call that produced it.
	const callNames = new Map<string, string>();
	const imagePlan = planToolImages(messages);

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "user") {
			out.push({ role: "user", parts: userParts(message) });
			continue;
		}
		if (message.role === "assistant") {
			const parts: unknown[] = [];
			if (message.content) parts.push({ text: message.content });
			for (const call of message.toolCalls) {
				callNames.set(call.id, call.name);
				parts.push({
					functionCall: {
						name: call.name,
						args: call.input ?? {},
						...(isProviderCallId(call.id) ? { id: call.id } : {}),
					},
					...(call.signature ? { thoughtSignature: call.signature } : {}),
				});
			}
			if (parts.length > 0) out.push({ role: "model", parts });
			continue;
		}
		const parts: unknown[] = [];
		const imageParts: unknown[] = [];
		for (const [resultIndex, result] of message.results.entries()) {
			const rendered = renderToolResult(
				result.output,
				imagePlan.has(`${messageIndex}:${resultIndex}`),
			);
			parts.push({
				functionResponse: {
					name: callNames.get(result.id) ?? result.name,
					...(isProviderCallId(result.id) ? { id: result.id } : {}),
					response: { result: rendered.text || "(no output)" },
				},
			});
			for (const image of rendered.images) {
				imageParts.push({
					inlineData: { mimeType: image.mediaType, data: image.base64 },
				});
			}
		}
		if (imageParts.length > 0) {
			parts.push({ text: TOOL_IMAGE_NOTE }, ...imageParts);
		}
		out.push({ role: "user", parts });
	}
	return out;
}

/** Ids we minted are local bookkeeping; only Gemini's own may go back on the wire. */
function isProviderCallId(id: string): boolean {
	return !id.startsWith("gemini_call_");
}

function userParts(message: Extract<ByokMessage, { role: "user" }>): unknown[] {
	const parts: unknown[] = [];
	for (const attachment of message.attachments ?? []) {
		if (attachment.base64) {
			parts.push({
				inlineData: {
					mimeType: attachment.mediaType,
					data: attachment.base64,
				},
			});
		} else if (attachment.text) {
			parts.push({
				text: `Attached file ${attachment.path}:\n${attachment.text}`,
			});
		}
	}
	parts.push({ text: message.content || "(empty message)" });
	return parts;
}
