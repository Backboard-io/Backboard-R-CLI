import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { qSessionDir } from "../src/config/paths.ts";
import { SessionStore } from "../src/core/session/SessionStore.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { ByokClient } from "../src/providers/byok/ByokClient.ts";
import { ByokConversationStore } from "../src/providers/byok/ByokConversationStore.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function collect(
	stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
	const events: ProviderEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function stubAnthropic(text: string): void {
	globalThis.fetch = (async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (const frame of [
						{
							type: "message_start",
							message: { usage: { input_tokens: 3 } },
						},
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text" },
						},
						{
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text },
						},
						{ type: "content_block_stop", index: 0 },
						{
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 2 },
						},
						{ type: "message_stop" },
					]) {
						controller.enqueue(
							new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
						);
					}
					controller.close();
				},
			}),
			{ status: 200 },
		)) as unknown as typeof fetch;
}

describe("ByokConversationStore", () => {
	it("preserves opaque provider metadata used by tool continuations", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_metadata", cwd);
		await session.init({
			sessionId: "sess_metadata",
			createdAt: new Date().toISOString(),
			cwd,
			model: "openrouter/anthropic/claude-haiku-4.5",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const providerMetadata = JSON.stringify([
			{ type: "reasoning.encrypted", data: "opaque" },
		]);

		await store.save(
			{
				version: 1,
				revision: 0,
				threadId: "byok_metadata",
				sessionId: "sess_metadata",
				sessionRoot: session.paths.root,
				provider: "openrouter",
				model: "anthropic/claude-haiku-4.5",
				systemPrompt: "test",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: [
					{ role: "user", content: "call a tool" },
					{
						role: "assistant",
						content: "",
						toolCalls: [{ id: "call_1", name: "read", input: {} }],
						providerMetadata,
					},
					{
						role: "tool",
						results: [{ id: "call_1", name: "read", output: "result" }],
					},
				],
			},
			0,
		);
		const loaded = await store.get("byok_metadata", {
			repairInterruptedToolTurn: false,
		});

		expect(
			loaded?.messages.find((message) => message.role === "assistant"),
		).toMatchObject({
			providerMetadata,
		});
	});

	it("persists and reloads a top-level BYOK conversation", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_one", cwd);
		await session.init({
			sessionId: "sess_one",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/claude-test",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const client = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("done");

		await collect(
			client.runMessage(
				{
					content: "<system-reminder>disk changed</system-reminder>\n\nhello",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					displayContent: "hello",
					durableSession: {
						sessionId: "sess_one",
						sessionRoot: session.paths.root,
					},
				},
			),
		);

		const threads = await client.listThreads();
		expect(threads).toHaveLength(1);
		expect(threads[0]?.first_user_message).toBe("hello");
		expect(threads[0]?.messages.map((message) => message.content)).toEqual([
			"hello",
			"done",
		]);

		const reopened = new ByokClient(() => "sk-ant-test", undefined, store);
		const hydrated = await reopened.getThread(threads[0]?.thread_id ?? "");
		expect(hydrated.first_user_message).toBe("hello");
		expect(hydrated.metadata_?.backboard_session_id).toBe("sess_one");
	});

	it("keeps helper conversations out of the durable session list", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const store = new ByokConversationStore(cwd);
		const client = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("summary");

		await collect(
			client.runMessage({
				content: "compact this",
				llm_provider: "anthropic",
				model_name: "claude-test",
			}),
		);

		expect(await store.list()).toEqual([]);
	});

	it("persists a user message when the provider completes with an empty reply", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_empty", cwd);
		await session.init({
			sessionId: "sess_empty",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/claude-test",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const client = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("");

		await collect(
			client.runMessage(
				{
					content: "remember this",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_empty",
						sessionRoot: session.paths.root,
					},
				},
			),
		);

		const [thread] = await new ByokClient(
			() => "sk-ant-test",
			undefined,
			store,
		).listThreads();
		expect(thread?.first_user_message).toBe("remember this");
	});

	it("reloads the latest stored revision when resuming in the same process", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_reload", cwd);
		await session.init({
			sessionId: "sess_reload",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/claude-test",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const first = new ByokClient(() => "sk-ant-test", undefined, store);
		const stale = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("first answer");
		await collect(
			first.runMessage(
				{
					content: "first",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_reload",
						sessionRoot: session.paths.root,
					},
				},
			),
		);
		const [listed] = await first.listThreads();
		const threadId = listed?.thread_id ?? "";
		await stale.getThread(threadId);
		stubAnthropic("second answer");
		await collect(
			first.runMessage(
				{
					content: "second",
					thread_id: threadId,
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_reload",
						sessionRoot: session.paths.root,
					},
				},
			),
		);

		const resumed = await stale.getThread(threadId);
		expect(resumed.messages.map((message) => message.content)).toContain(
			"second answer",
		);
	});

	it("keeps newer live messages when persistence left disk behind", async () => {
		class FailsNextStore extends ByokConversationStore {
			failNext = false;
			override async save(
				...args: Parameters<ByokConversationStore["save"]>
			): Promise<number> {
				if (this.failNext) {
					this.failNext = false;
					throw new Error("temporary disk failure");
				}
				return await super.save(...args);
			}
		}
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_live_newer", cwd);
		await session.init({
			sessionId: "sess_live_newer",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/claude-test",
			profile: "coding",
		});
		const store = new FailsNextStore(cwd);
		const client = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("first answer");
		await collect(
			client.runMessage(
				{
					content: "first",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_live_newer",
						sessionRoot: session.paths.root,
					},
				},
			),
		);
		const [listed] = await client.listThreads();
		store.failNext = true;
		stubAnthropic("unsaved second answer");
		const events = await collect(
			client.runMessage({
				content: "second",
				thread_id: listed?.thread_id,
				llm_provider: "anthropic",
				model_name: "claude-test",
			}),
		);
		expect(events.some((event) => event.kind === "warning")).toBe(true);

		const resumed = await client.getThread(listed?.thread_id ?? "");

		expect(resumed.messages.map((message) => message.content)).toContain(
			"unsaved second answer",
		);
	});

	it("transfers session ownership when compaction replaces a thread", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_compact", cwd);
		await session.init({
			sessionId: "sess_compact",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/claude-test",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const client = new ByokClient(() => "sk-ant-test", undefined, store);
		stubAnthropic("done");
		await collect(
			client.runMessage(
				{
					content: "before compact",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_compact",
						sessionRoot: session.paths.root,
					},
				},
			),
		);
		const [before] = await client.listThreads();
		for (let index = 0; index < 70; index++) {
			await collect(
				client.runMessage({
					content: `helper ${index}`,
					llm_provider: "anthropic",
					model_name: "claude-test",
				}),
			);
		}
		const events = await collect(
			client.runMessage(
				{
					content: "after compact",
					llm_provider: "anthropic",
					model_name: "claude-test",
				},
				{
					durableSession: {
						sessionId: "sess_compact",
						sessionRoot: session.paths.root,
						replacesThreadId: before?.thread_id,
					},
				},
			),
		);

		expect(events.some((event) => event.kind === "warning")).toBe(false);
		const [after] = await client.listThreads();
		expect(after?.thread_id).not.toBe(before?.thread_id);
		expect(after?.first_user_message).toBe("after compact");
	});

	it("skips malformed records whose session id does not own the directory", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const root = qSessionDir(cwd, "sess_bad");
		await new SessionStore("sess_bad", cwd).init({
			sessionId: "sess_bad",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		await writeFile(
			path.join(root, "conversation.json"),
			JSON.stringify({
				version: 1,
				threadId: "byok_bad",
				sessionId: "../outside",
				sessionRoot: "/tmp/outside",
				provider: "anthropic",
				model: "test",
				systemPrompt: "",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				messages: [],
			}),
		);

		expect(await new ByokConversationStore(cwd).list()).toEqual([]);
		expect(
			await readFile(path.join(root, "conversation.json"), "utf8"),
		).toContain("/tmp/outside");
	});

	it("refuses to overwrite a schema-invalid conversation record", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_invalid", cwd);
		await session.init({
			sessionId: "sess_invalid",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const conversationPath = path.join(session.paths.root, "conversation.json");
		await writeFile(
			conversationPath,
			JSON.stringify({ version: 2, futureSchema: true }),
			"utf8",
		);
		const store = new ByokConversationStore(cwd);

		await expect(
			store.save(
				{
					version: 1,
					revision: 0,
					threadId: "byok_new",
					sessionId: "sess_invalid",
					sessionRoot: session.paths.root,
					provider: "anthropic",
					model: "test",
					systemPrompt: "",
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					messages: [{ role: "user", content: "do not overwrite" }],
				},
				0,
			),
		).rejects.toThrow("unsupported schema");
		expect(await readFile(conversationPath, "utf8")).toContain("futureSchema");
	});

	it("rejects stale revisions and a different thread taking the session root", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_owner", cwd);
		await session.init({
			sessionId: "sess_owner",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const store = new ByokConversationStore(cwd);
		const now = new Date().toISOString();
		const conversation = {
			version: 1 as const,
			revision: 0,
			threadId: "byok_owner",
			sessionId: "sess_owner",
			sessionRoot: session.paths.root,
			provider: "anthropic" as const,
			model: "test",
			systemPrompt: "",
			createdAt: now,
			updatedAt: now,
			messages: [],
		};

		expect(await store.save(conversation, 0)).toBe(1);
		await expect(store.save(conversation, 0)).rejects.toThrow(
			"changed in another CLI process",
		);
		await expect(
			store.save({ ...conversation, threadId: "byok_intruder" }, 1),
		).rejects.toThrow("already owned by conversation byok_owner");
		expect(
			await store.save(
				{ ...conversation, threadId: "byok_compacted", revision: 1 },
				1,
				"byok_owner",
			),
		).toBe(2);
	});

	it("keeps conversations resumable after the project directory moves", async () => {
		const parent = await mkdtemp(path.join(os.tmpdir(), "byok-project-move-"));
		const before = path.join(parent, "before");
		const after = path.join(parent, "after");
		await mkdir(before);
		const session = new SessionStore("sess_move", before);
		await session.init({
			sessionId: "sess_move",
			createdAt: new Date().toISOString(),
			cwd: before,
			model: "anthropic/test",
			profile: "coding",
		});
		const now = new Date().toISOString();
		await new ByokConversationStore(before).save(
			{
				version: 1,
				revision: 0,
				threadId: "byok_move",
				sessionId: "sess_move",
				sessionRoot: session.paths.root,
				provider: "anthropic",
				model: "test",
				systemPrompt: "",
				createdAt: now,
				updatedAt: now,
				messages: [],
			},
			0,
		);

		await rename(before, after);
		const [stored] = await new ByokConversationStore(after).list();
		expect(stored?.threadId).toBe("byok_move");
		expect(stored?.sessionRoot).toBe(qSessionDir(after, "sess_move"));
	});

	it("drops an interrupted trailing tool call when loading", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_tool", cwd);
		await session.init({
			sessionId: "sess_tool",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const now = new Date().toISOString();
		await writeFile(
			path.join(session.paths.root, "conversation.json"),
			JSON.stringify({
				version: 1,
				revision: 1,
				threadId: "byok_tool",
				sessionId: "sess_tool",
				sessionRoot: session.paths.root,
				provider: "anthropic",
				model: "test",
				systemPrompt: "",
				createdAt: now,
				updatedAt: now,
				messages: [
					{ role: "user", content: "read it" },
					{
						role: "assistant",
						content: "Reading.",
						toolCalls: [{ id: "call_1", name: "read", input: {} }],
					},
				],
			}),
		);

		const [stored] = await new ByokConversationStore(cwd).list();
		expect(stored?.messages).toEqual([{ role: "user", content: "read it" }]);
	});

	it("preserves a stored pending tool call while submitting its results", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_pending", cwd);
		await session.init({
			sessionId: "sess_pending",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const now = new Date().toISOString();
		await writeFile(
			path.join(session.paths.root, "conversation.json"),
			JSON.stringify({
				version: 1,
				revision: 1,
				threadId: "byok_pending",
				sessionId: "sess_pending",
				sessionRoot: session.paths.root,
				provider: "anthropic",
				model: "test",
				systemPrompt: "",
				createdAt: now,
				updatedAt: now,
				messages: [
					{ role: "user", content: "read it" },
					{
						role: "assistant",
						content: "Reading.",
						toolCalls: [{ id: "call_1", name: "read", input: {} }],
					},
				],
			}),
		);
		stubAnthropic("finished");
		const client = new ByokClient(
			() => "sk-ant-test",
			undefined,
			new ByokConversationStore(cwd),
		);

		const events = await collect(
			client.runToolOutputs({
				thread_id: "byok_pending",
				tool_outputs: [{ tool_call_id: "call_1", output: "contents" }],
				tools: [],
			}),
		);

		expect(events.some((event) => event.kind === "completed")).toBe(true);
		const stored = await new ByokConversationStore(cwd).get("byok_pending", {
			repairInterruptedToolTurn: false,
		});
		expect(stored?.messages.some((message) => message.role === "tool")).toBe(
			true,
		);
	});

	it("falls back to model content when saved display content is empty", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "byok-sessions-"));
		const session = new SessionStore("sess_display", cwd);
		await session.init({
			sessionId: "sess_display",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const now = new Date().toISOString();
		await writeFile(
			path.join(session.paths.root, "conversation.json"),
			JSON.stringify({
				version: 1,
				revision: 1,
				threadId: "byok_display",
				sessionId: "sess_display",
				sessionRoot: session.paths.root,
				provider: "anthropic",
				model: "test",
				systemPrompt: "",
				createdAt: now,
				updatedAt: now,
				messages: [
					{ role: "user", content: "visible fallback", displayContent: "" },
				],
			}),
		);

		const client = new ByokClient(
			() => "sk-ant-test",
			undefined,
			new ByokConversationStore(cwd),
		);
		const thread = await client.getThread("byok_display");
		expect(thread.first_user_message).toBe("visible fallback");
		expect(thread.messages[0]?.content).toBe("visible fallback");
	});
});
