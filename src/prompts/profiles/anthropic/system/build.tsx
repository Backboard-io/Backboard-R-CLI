import type { SystemPromptOptions } from "../../../system/types.ts";
import { buildSystemPromptWith } from "../../_shared/system/build.tsx";
import { browser } from "./browser.tsx";
import { computer } from "./computer.tsx";
import { getSystemPromptFragment } from "./fragments.tsx";

/**
 * Builds the Anthropic-profile system prompt. Reuses the shared assembly
 * contract (ordering + "drop empty parts"), supplying only the Anthropic
 * persona fragments and computer/browser notices so structure can't drift.
 */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
	return buildSystemPromptWith(
		{ getSystemPromptFragment, computer, browser },
		options,
	);
}
