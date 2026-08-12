import { resolvePromptProfile } from "../profiles/index.ts";
import type { SystemPromptOptions } from "./types.ts";

export type { SystemPromptOptions } from "./types.ts";

/**
 * Public entrypoint for the system prompt. Selects the prompt profile from
 * `options.profile` (defaulting to `default`) and delegates to that profile's
 * builder. Keeps a stable import path so callers never need to know about the
 * per-profile layout.
 */
export function getSystemPrompt(options: SystemPromptOptions = {}): string {
	return resolvePromptProfile(options.profile).buildSystemPrompt(options);
}
