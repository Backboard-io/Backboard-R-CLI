/**
 * Cheap local token estimation.
 *
 * Used only for the per-component breakdown in `/context`, never for anything
 * that must be exact. The authoritative total comes from the provider's own
 * usage report on the last turn - this exists to answer "what is filling the
 * window", which no provider tells us. Every number derived from here is
 * rendered with a `~` so it never reads as measured.
 *
 * The ~3.7 chars/token divisor is tuned for source code and English prose,
 * which is what a coding transcript is made of; pure prose runs closer to 4.
 */
const CHARS_PER_TOKEN = 3.7;

/** Per-message wire overhead (role markers, delimiters) charged by every API. */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateJsonTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	try {
		return estimateTokens(JSON.stringify(value));
	} catch {
		return 0;
	}
}

export function estimateMessageTokens(text: string): number {
	return estimateTokens(text) + MESSAGE_OVERHEAD_TOKENS;
}

/** Formats a token count the way the readouts show it: 1200 -> "1.2k". */
export function formatTokens(tokens: number): string {
	if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));
	if (tokens < 1_000_000)
		return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}
