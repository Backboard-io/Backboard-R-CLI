import { describe, expect, it } from "bun:test";
import { FINAL_VERIFICATION_NUDGE } from "../src/prompts/finalVerification.ts";
import {
	PLAN_UP_TO_DATE_REPLY,
	todoReconciliationReminder,
} from "../src/prompts/todoReminders.ts";
import {
	backboardThreadToMessages,
	sortThreadsByUpdatedAt,
	threadUpdatedAt,
} from "../src/providers/backboard/threads.ts";
import type {
	BackboardThread,
	BackboardThreadMessage,
} from "../src/providers/backboard/types.ts";

describe("Backboard thread helpers", () => {
	it("uses the latest message timestamp as the thread updated time", () => {
		const thread = testThread("older", "2026-06-30T10:00:00", [
			"2026-06-30T10:01:00",
			"2026-06-30T15:42:00",
		]);

		expect(threadUpdatedAt(thread)).toBe("2026-06-30T15:42:00");
	});

	it("sorts threads newest updated first", () => {
		const olderCreatedNewerUpdated = testThread("a", "2026-06-30T10:00:00", [
			"2026-06-30T15:42:00",
		]);
		const newerCreatedOlderUpdated = testThread("b", "2026-06-30T15:00:00", [
			"2026-06-30T15:01:00",
		]);

		expect(
			sortThreadsByUpdatedAt([
				newerCreatedOlderUpdated,
				olderCreatedNewerUpdated,
			]).map((thread) => thread.thread_id),
		).toEqual(["a", "b"]);
	});

	it("filters injected notification exchanges out of resumed threads", () => {
		const thread = threadWithMessages([
			{ role: "user", content: "build the feature" },
			{ role: "assistant", content: "Done." },
			{ role: "user", content: FINAL_VERIFICATION_NUDGE },
			{ role: "assistant", content: "Verified summary." },
			{
				role: "user",
				content: todoReconciliationReminder([
					{ id: "todo_1", content: "Ship it", status: "pending" },
				]),
			},
			{ role: "assistant", content: PLAN_UP_TO_DATE_REPLY },
		]);

		const messages = backboardThreadToMessages(thread);
		expect(messages).toHaveLength(3);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
		]);
	});

	it("drops metadata-tagged injected user turns regardless of content", () => {
		const thread = threadWithMessages([
			{ role: "user", content: "build the feature" },
			{
				role: "user",
				content: "arbitrary reminder text",
				metadata_: { injected_notification: "todo-reconciliation" },
			},
			{ role: "assistant", content: "Done." },
		]);

		const messages = backboardThreadToMessages(thread);
		expect(messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect((messages[0] as { text: string }).text).toBe("build the feature");
	});

	it("keeps a real assistant answer that merely mentions the sentinel", () => {
		const thread = threadWithMessages([
			{ role: "user", content: "status?" },
			{
				role: "assistant",
				content: `I checked everything. ${PLAN_UP_TO_DATE_REPLY}`,
			},
		]);

		expect(backboardThreadToMessages(thread)).toHaveLength(2);
	});

	it("still drops a pre-tag verification nudge that carried workspace metadata", () => {
		// The nudge exact-match must run regardless of metadata: pre-tag injected
		// nudges in workspace threads carry backboard_workspace_id, and a human
		// never types the entire multi-paragraph nudge.
		const thread = threadWithMessages([
			{ role: "user", content: "do the thing" },
			{
				role: "user",
				content: FINAL_VERIFICATION_NUDGE,
				metadata_: { backboard_workspace_id: "ws_1" },
			},
			{ role: "assistant", content: "Verified." },
		]);

		expect(backboardThreadToMessages(thread).map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("keeps a genuine user message that carries metadata even if it looks injected", () => {
		// The content fallback only fires for metadata-free pre-tag messages, so
		// a real user turn with its own metadata is never dropped by the
		// heuristic - even one that starts with "<system-reminder>".
		const thread = threadWithMessages([
			{
				role: "user",
				content: "<system-reminder> please read this note",
				metadata_: { custom_timestamp: "2026-07-08T00:00:00Z" },
			},
		]);

		const messages = backboardThreadToMessages(thread);
		expect(messages).toHaveLength(1);
		expect((messages[0] as { text: string }).text).toBe(
			"<system-reminder> please read this note",
		);
	});
});

function threadWithMessages(
	messages: Pick<BackboardThreadMessage, "role" | "content" | "metadata_">[],
): BackboardThread {
	return {
		thread_id: "thread_test",
		created_at: "2026-06-30T10:00:00",
		messages: messages.map((message, index) => ({
			message_id: `m-${index}`,
			created_at: "2026-06-30T10:00:00",
			...message,
		})),
	};
}

function testThread(
	threadId: string,
	createdAt: string,
	messageTimes: string[],
): BackboardThread {
	return {
		thread_id: threadId,
		created_at: createdAt,
		messages: messageTimes.map((created_at, index) => ({
			message_id: `${threadId}-${index}`,
			role: "user",
			content: `message ${index}`,
			created_at,
		})),
	};
}
