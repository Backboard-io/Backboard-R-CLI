import type { SystemPromptFragmentId } from "../../../../config/modelProfiles/types.ts";
import {
	type PromptContext,
	type PromptModule,
	renderPrompt,
} from "../../../PromptModule.ts";
import { core } from "./core.tsx";

/**
 * Shared/default system fragments. Mirrors the global fragment registry but
 * resolves `core` to the neutral default persona owned by this profile, so the
 * default profile no longer depends on the legacy `system/core.tsx`.
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
