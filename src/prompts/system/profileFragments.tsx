import type { SystemPromptFragmentId } from "../../config/modelProfiles/types.ts";
import {
	type PromptContext,
	type PromptModule,
	renderPrompt,
} from "../PromptModule.ts";
import { core } from "./core.tsx";

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
