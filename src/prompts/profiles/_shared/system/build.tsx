import type { SystemPromptFragmentId } from "../../../../config/modelProfiles/types.ts";
import type { PromptContext, PromptModule } from "../../../PromptModule.ts";
import { browser as sharedBrowser } from "../../../system/browser.tsx";
import { computer as sharedComputer } from "../../../system/computer.tsx";
import { SKILL_DISCOVERY_GUIDANCE } from "../../../system/skillDiscovery.tsx";
import { buildSkillCatalogPrompt } from "../../../system/skills.tsx";
import type { SystemPromptOptions } from "../../../system/types.ts";
import { getSystemPromptFragment as sharedFragment } from "./fragments.tsx";

/**
 * Profile-swappable pieces of the system-prompt assembly. Everything else —
 * ordering, the "drop empty parts" rule, skill/hook/environment slots — is
 * fixed here so profiles can't accidentally diverge on structure. A profile
 * supplies only the persona fragment resolver and its computer/browser
 * notices; wording differences live in those, not in a copied builder.
 */
export interface SystemPromptDeps {
	getSystemPromptFragment: (
		id: SystemPromptFragmentId,
		context?: PromptContext,
	) => string;
	computer: PromptModule;
	browser: PromptModule;
}

const defaultDeps: SystemPromptDeps = {
	getSystemPromptFragment: sharedFragment,
	computer: sharedComputer,
	browser: sharedBrowser,
};

/**
 * Assembles the full system prompt from its parts. Empty parts are dropped.
 * This is the canonical assembly contract shared by every prompt profile; a
 * profile customizes only the pieces in {@link SystemPromptDeps} by calling
 * this with its own `deps` rather than copying the function.
 */
export function buildSystemPromptWith(
	deps: SystemPromptDeps,
	options: SystemPromptOptions = {},
): string {
	const layout = options.layout ?? { base: "core" };
	const promptContext = {
		enabledTools: options.enabledTools,
		profile: options.profile,
	};
	return [
		layout.header
			? deps.getSystemPromptFragment(layout.header, promptContext)
			: "",
		deps.getSystemPromptFragment(layout.base, promptContext),
		options.computerUseEnabled ? deps.computer.prompt : "",
		options.browserUseEnabled ? deps.browser.prompt : "",
		options.expertModePrompt,
		options.startupEnvironmentPrompt,
		options.skillDiscoveryEnabled ? SKILL_DISCOVERY_GUIDANCE : "",
		buildSkillCatalogPrompt(options.skillCatalog),
		options.activatedSkillsPrompt,
		options.hookContext,
		options.todoReminderPrompt,
		layout.footer ? deps.getSystemPromptFragment(layout.footer) : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** The shared builder bound to the `_shared` fragments and notices. */
export function buildSystemPrompt(options: SystemPromptOptions = {}): string {
	return buildSystemPromptWith(defaultDeps, options);
}
