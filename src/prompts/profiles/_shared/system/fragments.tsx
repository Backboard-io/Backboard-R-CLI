import type { SystemPromptFragmentId } from "../../../../config/modelProfiles/types.ts";
import {
	type PromptContext,
	type PromptModule,
	renderPrompt,
} from "../../../PromptModule.ts";
import { core } from "./core.tsx";

/**
 * System fragments shared by every profile. `core` resolves to the master
 * persona in `./core.tsx`.
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
