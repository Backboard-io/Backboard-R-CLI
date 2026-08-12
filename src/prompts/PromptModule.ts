import { canonicalToolName } from "../core/tools/names.ts";
import type { PromptProfileId } from "./profiles/ids.ts";

/**
 * Shared shape for every prompt module. Today each one exports an empty string;
 * authoring prompts later means filling `prompt` in - no structural change to
 * any importer. Kept as `.tsx`-friendly plain data so prompts can later compose
 * JSX-derived strings if desired.
 */
export interface PromptModule {
	prompt: string;
	render?: (context: PromptContext) => string;
}

export interface PromptContext {
	enabledTools?: readonly string[];
	commandShellKind?: "bash" | "posix";
	commandShellPath?: string;
	profile?: PromptProfileId;
}

export function definePrompt(
	prompt = "",
	render?: (context: PromptContext) => string,
): PromptModule {
	return render ? { prompt, render } : { prompt };
}

export function renderPrompt(
	module: PromptModule,
	context: PromptContext = {},
): string {
	return module.render?.(context) ?? module.prompt;
}

export function hasTool(context: PromptContext, name: string): boolean {
	const expected = canonicalToolName(name);
	return (
		context.enabledTools === undefined ||
		context.enabledTools.some(
			(toolName) => canonicalToolName(toolName) === expected,
		)
	);
}
