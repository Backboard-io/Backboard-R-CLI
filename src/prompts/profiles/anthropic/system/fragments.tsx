import type { SystemPromptFragmentId } from "../../../../config/modelProfiles/types.ts";
import {
	type PromptContext,
	type PromptModule,
	renderPrompt,
} from "../../../PromptModule.ts";
import { core } from "./core.tsx";

/**
 * Anthropic-profile system fragments. Mirrors the shared fragment registry but
 * resolves to this profile's own persona modules.
 */
export const systemPromptFragments: Record<
	SystemPromptFragmentId,
	PromptModule
> = {
	core,
};

export function getSystemPromptFragment(
	id: SystemPromptFragmentId,
	context: PromptContext = {},
): string {
	return renderPrompt(systemPromptFragments[id], context);
}
