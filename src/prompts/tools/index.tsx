import { canonicalToolName } from "../../core/tools/names.ts";
import {
	type PromptContext,
	type PromptModule,
	renderPrompt,
} from "../PromptModule.ts";
import { resolvePromptProfile } from "../profiles/index.ts";

/**
 * Default-profile tool prompt map. Retained as a named export for tooling
 * (e.g. prompt export scripts) that enumerate every tool prompt.
 */
export const toolPrompts: Record<string, PromptModule> =
	resolvePromptProfile("default").toolPrompts;

/**
 * Public entrypoint for tool prompts. Selects the prompt profile from
 * `context.profile` (defaulting to `default`) and renders the matching tool's
 * model-facing description.
 */
export function getToolPrompt(
	name: string,
	context: PromptContext = {},
): string {
	const prompts = resolvePromptProfile(context.profile).toolPrompts;
	const prompt = prompts[canonicalToolName(name)];
	return prompt ? renderPrompt(prompt, context) : "";
}
