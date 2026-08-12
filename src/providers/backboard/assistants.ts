import { createHash } from "node:crypto";
import { APP_PACKAGE_NAME } from "../../config/branding.ts";
import type { OpenAITool } from "../../core/tools/schema.ts";
import { shortId } from "../../utils/id.ts";
import type { AgentClient, RequestOptions } from "../AgentClient.ts";

export interface EnsureAssistantOptions extends RequestOptions {
	/**
	 * Force a brand-new assistant instead of reusing one that matches the
	 * system-prompt/tools fingerprint. Used to keep eval trials isolated.
	 */
	fresh?: boolean;
}

export async function ensureAssistant(
	client: AgentClient,
	systemPrompt: string,
	tools: OpenAITool[],
	options: EnsureAssistantOptions = {},
): Promise<string> {
	const { fresh, ...requestOptions } = options;
	const fingerprint = createHash("sha256")
		.update(systemPrompt)
		.update(JSON.stringify(tools))
		.digest("hex")
		.slice(0, 12);
	const name = fresh
		? `${APP_PACKAGE_NAME} coding ${fingerprint} ${shortId()}`
		: `${APP_PACKAGE_NAME} coding ${fingerprint}`;

	if (!fresh) {
		const assistants = await client.listAssistants(requestOptions, { name });
		const existing = assistants.find((a) => a.name === name);
		if (existing?.assistant_id) return existing.assistant_id;
	}

	const created = await client.createAssistant(
		{
			name,
			system_prompt: systemPrompt,
			tools,
		},
		requestOptions,
	);
	if (!created.assistant_id) {
		throw new Error("Backboard did not return an assistant id.");
	}
	return created.assistant_id;
}
