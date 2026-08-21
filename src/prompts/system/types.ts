import type { SystemPromptLayout } from "../../config/modelProfiles/index.ts";
import type { SkillCatalog } from "../../core/skills/SkillCatalog.ts";
import type { PromptProfileId } from "../profiles/ids.ts";

export interface SystemPromptOptions {
	layout?: SystemPromptLayout;
	computerUseEnabled?: boolean;
	browserUseEnabled?: boolean;
	skillDiscoveryEnabled?: boolean;
	/** Present only while expert mode is on; names the execution model. */
	expertModePrompt?: string;
	skillCatalog?: SkillCatalog;
	activatedSkillsPrompt?: string;
	hookContext?: string;
	/** Reminder segment shown until the session's first TodoWrite call. */
	todoReminderPrompt?: string;
	startupEnvironmentPrompt?: string;
	enabledTools?: readonly string[];
	/** Selects which prompt profile builds the prompt. Defaults to `default`. */
	profile?: PromptProfileId;
}
