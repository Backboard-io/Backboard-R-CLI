import type { ModelRef } from "../../config/defaults.ts";

/**
 * Context-window sizes for direct vendor models.
 *
 * Backboard reports `context_limit` per model in its catalog and again in the
 * per-turn `context_usage` payload, so this table only covers BYOK, where no
 * such endpoint exists. Patterns are ordered most-specific first and matched
 * against the lowercased model id.
 */
const WINDOW_PATTERNS: ReadonlyArray<{ match: RegExp; tokens: number }> = [
	// Anthropic
	{ match: /^claude-(?:opus|sonnet|haiku|fable)-[5-9]/, tokens: 200_000 },
	{ match: /^claude-/, tokens: 200_000 },
	// OpenAI
	{ match: /^gpt-4\.1/, tokens: 1_047_576 },
	{ match: /^gpt-5/, tokens: 400_000 },
	{ match: /^o[1-9]($|[-.])/, tokens: 200_000 },
	{ match: /^gpt-4o|^gpt-4-turbo/, tokens: 128_000 },
	{ match: /^gpt-4($|[-.])/, tokens: 8_192 },
	{ match: /^gpt-3\.5/, tokens: 16_385 },
	// Google
	{ match: /^gemini-1\.5-pro/, tokens: 2_097_152 },
	{ match: /^gemini-/, tokens: 1_048_576 },
];

/**
 * Deliberately conservative: over-estimating the window would let a
 * conversation sail past the real limit and hard-fail mid-task, which is a far
 * worse outcome than compressing a little early.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function contextWindowFor(model: ModelRef): number {
	const rawName = model.model.trim().toLowerCase();
	const name =
		model.provider.trim().toLowerCase() === "openrouter"
			? (rawName.split("/").at(-1) ?? rawName)
			: rawName;
	for (const { match, tokens } of WINDOW_PATTERNS) {
		if (match.test(name)) return tokens;
	}
	return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolves the window to use, preferring anything the backend reported.
 * A server-reported limit is always right for that turn; the table is the
 * fallback for BYOK and for catalogs that omit it.
 */
export function resolveContextWindow(
	model: ModelRef,
	reportedLimit?: number | null,
): number {
	if (typeof reportedLimit === "number" && reportedLimit > 0) {
		return reportedLimit;
	}
	return contextWindowFor(model);
}
