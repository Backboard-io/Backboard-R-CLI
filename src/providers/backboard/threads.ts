import { INJECTED_NOTIFICATION_METADATA_KEY } from "../../core/agent/notifications/SystemNotification.ts";
import {
	assistantMessage,
	type Message,
	toolMessage,
	userMessage,
} from "../../core/session/Message.ts";
import { FINAL_VERIFICATION_NUDGE } from "../../prompts/finalVerification.ts";
import { PLAN_UP_TO_DATE_REPLY } from "../../prompts/todoReminders.ts";
import { truncate } from "../../utils/string.ts";
import { isRawToolCall, mapToolCall } from "./mappers.ts";
import type { BackboardThread, BackboardThreadMessage } from "./types.ts";

export { truncate } from "../../utils/string.ts";

export function threadDisplayTitle(thread: BackboardThread): string {
	const title = thread.title?.trim();
	if (title) return title;
	const firstUserPreview = thread.first_user_message
		?.replace(/\s+/g, " ")
		.trim();
	if (firstUserPreview) return truncate(firstUserPreview, 60);
	const firstUser = thread.messages.find((message) => message.role === "user");
	const content = firstUser?.content?.replace(/\s+/g, " ").trim();
	if (content) return truncate(content, 60);
	return `Session ${thread.thread_id.slice(0, 8)}`;
}

export function threadMessageCount(thread: BackboardThread): number {
	if (typeof thread.message_count === "number") return thread.message_count;
	return thread.messages.filter((message) => message.role !== "tool").length;
}

export function threadModelLabel(thread: BackboardThread): string {
	const message = findLastMessage(thread, (candidate) =>
		Boolean(candidate.model_name || candidate.model_provider),
	);
	if (!message) return "";
	const provider = message.model_provider ? `${message.model_provider}/` : "";
	return `${provider}${message.model_name ?? ""}`;
}

export function threadUpdatedAt(thread: BackboardThread): string | null {
	if (thread.updated_at) return thread.updated_at;
	const latestMessage = findLastMessage(thread, (message) =>
		Boolean(message.created_at),
	);
	return latestMessage?.created_at ?? thread.created_at ?? null;
}

export function sortThreadsByUpdatedAt(
	threads: readonly BackboardThread[],
): BackboardThread[] {
	return threads
		.map((thread) => ({
			thread,
			updatedAt: threadUpdatedTimestamp(thread),
		}))
		.sort((left, right) => {
			if (right.updatedAt !== left.updatedAt) {
				return right.updatedAt - left.updatedAt;
			}
			return right.thread.thread_id.localeCompare(left.thread.thread_id);
		})
		.map(({ thread }) => thread);
}

export function backboardThreadToMessages(thread: BackboardThread): Message[] {
	return thread.messages
		.map(backboardMessageToSessionMessage)
		.filter((message): message is Message => message !== null);
}

function threadUpdatedTimestamp(thread: BackboardThread): number {
	const value = threadUpdatedAt(thread);
	if (!value) return 0;
	const time = new Date(value).getTime();
	return Number.isNaN(time) ? 0 : time;
}

function findLastMessage(
	thread: BackboardThread,
	predicate: (message: BackboardThreadMessage) => boolean,
): BackboardThreadMessage | undefined {
	for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
		const message = thread.messages[index];
		if (message && predicate(message)) return message;
	}
	return undefined;
}

function backboardMessageToSessionMessage(
	message: BackboardThreadMessage,
): Message | null {
	const content = message.content ?? "";
	switch (message.role) {
		case "user":
			// Injected system notifications persist server-side as ordinary user
			// messages; drop them on resume so they don't render as human input.
			if (isInjectedNotificationMessage(message, content)) return null;
			return userMessage(content);
		case "assistant": {
			const toolCalls = toolCallsFromMetadata(message.metadata_);
			// The hidden reconciliation reply was never shown; keep it that way.
			// The reply carries no injection tag (the tag rides on the request,
			// not the model's answer) and assistant messages always carry model
			// metadata, so this can't be metadata-scoped - we accept the rare
			// false positive of dropping a genuine bare "Plan is up-to-date."
			// reply, which only affects resume rendering.
			if (toolCalls.length === 0 && content.trim() === PLAN_UP_TO_DATE_REPLY) {
				return null;
			}
			return assistantMessage(content, toolCalls);
		}
		case "tool":
			return toolMessage([
				{
					toolCallId: stringMetadata(message.metadata_, "tool_call_id") ?? "",
					name: stringMetadata(message.metadata_, "tool_name") ?? "Tool",
					output: content,
					isError: message.status === "FAILED",
				},
			]);
		default:
			return null;
	}
}

function isInjectedNotificationMessage(
	message: BackboardThreadMessage,
	content: string,
): boolean {
	// Tagged messages are the reliable signal.
	if (message.metadata_?.[INJECTED_NOTIFICATION_METADATA_KEY] != null) {
		return true;
	}
	const trimmed = content.trim();
	// Exact full-text match on the verification nudge is safe regardless of
	// metadata - a human never types the entire multi-paragraph nudge - so it
	// still catches pre-tag injected nudges that carried workspace metadata.
	if (trimmed === FINAL_VERIFICATION_NUDGE.trim()) {
		return true;
	}
	// The fuzzy prefix match is a last-resort fallback for pre-tag threads and
	// could hit a genuine message. Scope it to metadata-free rows only: pre-tag
	// injected turns were plain under the default memory-off config, so this
	// still catches them while never dropping a real user message - which may
	// legitimately start with "<system-reminder>" - that carries any metadata.
	if (message.metadata_ && Object.keys(message.metadata_).length > 0) {
		return false;
	}
	return trimmed.startsWith("<system-reminder>");
}

function toolCallsFromMetadata(
	metadata: Record<string, unknown> | null | undefined,
): { id: string; name: string; input: unknown }[] {
	const raw = metadata?.tool_calls;
	if (!Array.isArray(raw)) return [];
	return raw.filter(isRawToolCall).map(mapToolCall);
}

function stringMetadata(
	metadata: Record<string, unknown> | null | undefined,
	key: string,
): string | null {
	const value = metadata?.[key];
	return typeof value === "string" ? value : null;
}
