import type { PromptModule } from "../PromptModule.ts";
import type { SystemPromptOptions } from "../system/types.ts";
import { buildSystemPrompt as anthropicSystem } from "./anthropic/system/index.tsx";
import { toolPrompts as anthropicTools } from "./anthropic/tools/index.tsx";
import { buildSystemPrompt as defaultSystem } from "./default/system/index.tsx";
import { toolPrompts as defaultTools } from "./default/tools/index.tsx";
import { buildSystemPrompt as glmSystem } from "./glm/system/index.tsx";
import { toolPrompts as glmTools } from "./glm/tools/index.tsx";
import { type PromptProfileId, toPromptProfileId } from "./ids.ts";
import { buildSystemPrompt as openaiSystem } from "./openai/system/index.tsx";
import { toolPrompts as openaiTools } from "./openai/tools/index.tsx";

export {
	PROMPT_PROFILE_IDS,
	type PromptProfileId,
	toPromptProfileId,
} from "./ids.ts";

/** A prompt profile bundles the system builder and tool prompt set. */
export interface PromptProfile {
	id: PromptProfileId;
	buildSystemPrompt: (options?: SystemPromptOptions) => string;
	toolPrompts: Record<string, PromptModule>;
}

const PROMPT_PROFILES: Record<PromptProfileId, PromptProfile> = {
	default: {
		id: "default",
		buildSystemPrompt: defaultSystem,
		toolPrompts: defaultTools,
	},
	openai: {
		id: "openai",
		buildSystemPrompt: openaiSystem,
		toolPrompts: openaiTools,
	},
	anthropic: {
		id: "anthropic",
		buildSystemPrompt: anthropicSystem,
		toolPrompts: anthropicTools,
	},
	glm: {
		id: "glm",
		buildSystemPrompt: glmSystem,
		toolPrompts: glmTools,
	},
};

/** Resolves a prompt profile by id or model-profile name, defaulting safely. */
export function resolvePromptProfile(
	id: PromptProfileId | string | undefined,
): PromptProfile {
	return PROMPT_PROFILES[toPromptProfileId(id)];
}
