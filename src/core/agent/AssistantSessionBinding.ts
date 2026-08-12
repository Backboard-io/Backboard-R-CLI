import type { AgentClient } from "../../providers/AgentClient.ts";
import { ensureAssistant } from "../../providers/backboard/assistants.ts";
import type { Session } from "../session/Session.ts";
import type { OpenAITool } from "../tools/schema.ts";

export class AssistantSessionBinding {
	constructor(
		private readonly client: AgentClient,
		private readonly session: Session,
		private readonly fresh = false,
	) {}

	async resolve(input: {
		systemPrompt: string;
		tools: OpenAITool[];
		signal?: AbortSignal;
	}): Promise<string> {
		if (this.session.assistantId) return this.session.assistantId;

		const assistantId = await ensureAssistant(
			this.client,
			input.systemPrompt,
			input.tools,
			{ signal: input.signal, fresh: this.fresh },
		);
		this.session.assistantId = assistantId;
		return assistantId;
	}
}
