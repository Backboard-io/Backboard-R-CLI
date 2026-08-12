export interface SseSplitResult {
	frames: string[];
	rest: string;
}

export function splitSseFrames(buffer: string): SseSplitResult {
	const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const parts = normalized.split("\n\n");
	return {
		frames: parts.slice(0, -1),
		rest: parts.at(-1) ?? "",
	};
}

/**
 * Reads a fetch response body and yields complete SSE frame strings, buffering
 * partial frames across chunks and flushing any trailing frame at the end. The
 * underlying reader is cancelled only when iteration stops before the stream's
 * natural EOF.
 */
export async function* readSseFrames(
	body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completedNaturally = false;

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const split = splitSseFrames(buffer);
			buffer = split.rest;
			yield* split.frames;
			// Buffered chunks resolve on the microtask queue, so a fast stream can
			// run this loop end-to-end without ever returning to the macrotask
			// queue - starving stdin and leaving Ctrl+C/Esc unresponsive until the
			// stream ends. Hand one turn back to the event loop per chunk so the
			// terminal's keypresses (cancellation) get serviced.
			await yieldToEventLoop();
		}
		buffer += decoder.decode();
		completedNaturally = true;
		if (buffer.trim()) yield buffer;
	} finally {
		if (!completedNaturally) {
			await reader.cancel().catch(() => undefined);
		}
	}
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The frame's `data:` payload, joined across continuation lines.
 *
 * Sentinels like OpenAI's `[DONE]` must be recognised from this, never from a
 * substring of the raw frame: the payload is JSON, so assistant content that
 * happens to contain the sentinel text would otherwise end the stream mid-turn.
 */
export function sseDataPayload(frame: string): string | null {
	const data: string[] = [];

	for (const line of frame.split("\n")) {
		if (!line || line.startsWith(":")) continue;
		if (line.startsWith("data:")) {
			data.push(line.slice(5).trimStart());
		}
	}

	if (data.length === 0) return null;
	const payload = data.join("\n").trim();
	return payload || null;
}

export function parseSseFrame(frame: string): unknown | null {
	const payload = sseDataPayload(frame);
	if (payload === null) return null;
	return JSON.parse(payload);
}
