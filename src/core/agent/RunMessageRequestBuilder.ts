import {
	formatBackboardMemoryMode,
	type MemoryMode,
	type MemoryProfile,
	type ThinkingConfig,
} from "../../config/defaults.ts";
import type { SendMessageRequest } from "../../providers/backboard/types.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";

export interface RunMessageRequestContext {
	session: Session;
	tools: OpenAITool[];
	systemPrompt: string;
	assistantId?: string;
	model: { provider: string; model: string };
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	workspaceId?: string;
	/**
	 * Extra metadata merged into the request. The server persists it on the
	 * stored message and returns it on resume, so injected notifications tag
	 * themselves here (see INJECTED_NOTIFICATION_METADATA_KEY) to be prunable
	 * server-side and filterable on resume.
	 */
	metadata?: Record<string, unknown>;
}

export function buildRunMessageRequest(
	content: string,
	context: RunMessageRequestContext,
	thinking?: ThinkingConfig | null,
): SendMessageRequest {
	const metadata = {
		...(context.workspaceId
			? { backboard_workspace_id: context.workspaceId }
			: {}),
		...context.metadata,
	};
	return {
		content,
		thread_id: context.session.threadId ?? undefined,
		assistant_id: context.assistantId,
		llm_provider: context.model.provider,
		model_name: context.model.model,
		system_prompt: context.systemPrompt,
		memory: formatBackboardMemoryMode(context.memory),
		memory_profile: context.memoryProfile,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		...(thinking === undefined ? {} : { thinking }),
		tools: context.tools,
	};
}
