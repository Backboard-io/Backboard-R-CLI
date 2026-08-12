import type { TodoItem } from "../bus/events.ts";
import type { Message } from "../session/Message.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * Per-tool-result cap when rendering history for compression. Tool output is
 * the bulk of a coding transcript and the most redundant part of it - a 400-line
 * file read matters as "this file was read and here is its shape", not as 400
 * lines. Head and tail are both kept because the interesting parts of command
 * output cluster at the ends (what ran, and how it finished).
 */
const TOOL_OUTPUT_HEAD_CHARS = 1_200;
const TOOL_OUTPUT_TAIL_CHARS = 600;

/**
 * The same cap for the verbatim tail, an order of magnitude looser.
 *
 * The tail exists to preserve the live edge exactly, so it is clamped only to
 * bound the worst case: one 2MB file read among the last few messages would
 * otherwise land whole in the resume context and leave the next prompt no
 * smaller than the one compression was meant to shrink - occasionally larger.
 */
const TAIL_OUTPUT_HEAD_CHARS = 12_000;
const TAIL_OUTPUT_TAIL_CHARS = 6_000;

function clampToolOutput(
	output: string,
	headChars: number,
	tailChars: number,
): string {
	if (output.length <= headChars + tailChars) return output;
	const head = output.slice(0, headChars);
	const tail = output.slice(-tailChars);
	const dropped = output.length - head.length - tail.length;
	return `${head}\n… [${dropped} characters omitted] …\n${tail}`;
}

function renderMessage(message: Message, clamp: boolean): string {
	if (message.role === "user") {
		return `USER: ${message.text}`;
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		if (message.text.trim()) parts.push(`ASSISTANT: ${message.text}`);
		for (const call of message.toolCalls) {
			parts.push(`ASSISTANT calls ${call.name}(${safeJson(call.input)})`);
		}
		return parts.join("\n");
	}
	return message.results
		.map((result) => {
			const output = String(result.output ?? "");
			const body = clamp
				? clampToolOutput(
						output,
						TOOL_OUTPUT_HEAD_CHARS,
						TOOL_OUTPUT_TAIL_CHARS,
					)
				: clampToolOutput(
						output,
						TAIL_OUTPUT_HEAD_CHARS,
						TAIL_OUTPUT_TAIL_CHARS,
					);
			return `TOOL ${result.name}${result.isError ? " [error]" : ""}: ${body}`;
		})
		.join("\n");
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "";
	}
}

export interface RenderedTranscript {
	/** Everything being compressed, with tool output clamped. */
	transcript: string;
	/** The newest exchanges, replayed word-for-word after the handoff. */
	verbatimTail: string;
	/** How many messages the tail covers. */
	verbatimCount: number;
}

/**
 * Splits history into "summarize this" and "keep this exactly".
 *
 * The tail is kept raw because compression is least trustworthy exactly where
 * it matters most: the turn in progress. A summary of "the agent was editing
 * ContextWindow.ts" is not enough to resume that edit; the actual exchange is.
 */
export function renderTranscript(
	messages: readonly Message[],
	options: { verbatimTailMessages: number },
): RenderedTranscript {
	const tailSize = Math.min(
		Math.max(options.verbatimTailMessages, 0),
		messages.length,
	);
	const splitAt = messages.length - tailSize;
	const head = messages.slice(0, splitAt);
	const tail = messages.slice(splitAt);

	return {
		transcript: head.map((m) => renderMessage(m, true)).join("\n\n"),
		// Clamped far more loosely than the summarized head - the live edge is
		// the point of keeping it - but not unbounded.
		verbatimTail: tail.map((m) => renderMessage(m, false)).join("\n\n"),
		verbatimCount: tail.length,
	};
}

export function renderTodos(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "";
	return todos.map((todo) => `- [${todo.status}] ${todo.content}`).join("\n");
}

/** Rough size of the transcript, for the before/after compression report. */
export function estimateTranscriptTokens(messages: readonly Message[]): number {
	let total = 0;
	for (const message of messages) {
		total += estimateTokens(renderMessage(message, false)) + 4;
	}
	return total;
}
