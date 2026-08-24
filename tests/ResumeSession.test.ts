import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/Config.ts";
import { qSessionDir } from "../src/config/paths.ts";
import type { AgentController } from "../src/core/agent/AgentController.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import { BackboardError } from "../src/providers/backboard/errors.ts";
import type { BackboardThread } from "../src/providers/backboard/types.ts";
import {
	BYOK_SESSION_ID_METADATA_KEY,
	BYOK_THREAD_METADATA_KEY,
	ByokConversationNotFoundError,
} from "../src/providers/byok/ByokClient.ts";
import { BackendUnavailableError } from "../src/providers/ClientRouter.ts";
import {
	activateResumeTarget,
	isAlreadyActiveResume,
	resolveResumeTarget,
} from "../src/ui/utils/resumeSession.ts";

describe("resolveResumeTarget", () => {
	it("resolves a Backboard thread ID", async () => {
		const thread = savedThread("thread_remote");
		const target = await resolveResumeTarget(
			fakeClient([thread]),
			"/tmp/project",
			thread.thread_id,
		);
		expect(target.thread?.thread_id).toBe("thread_remote");
		expect(target.localSessionId).toBeNull();
		expect(target.messages).toHaveLength(1);
	});

	it("resolves BYOK by either thread or local session ID", async () => {
		const thread = savedThread("byok_deadbeef", {
			[BYOK_THREAD_METADATA_KEY]: true,
			[BYOK_SESSION_ID_METADATA_KEY]: "sess_1234abcd",
			model_provider: "anthropic",
			model_name: "claude-test",
		});
		const client = fakeClient([thread]);
		expect(
			(await resolveResumeTarget(client, "/tmp/project", "byok_deadbeef"))
				.localSessionId,
		).toBe("sess_1234abcd");
		expect(
			(await resolveResumeTarget(client, "/tmp/project", "sess_1234abcd"))
				.thread?.thread_id,
		).toBe("byok_deadbeef");
	});

	it("resolves a local-only session directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const target = await resolveResumeTarget(
			fakeClient([]),
			cwd,
			"sess_deadbeef",
		);
		expect(target.thread).toBeNull();
		expect(target.localSessionId).toBe("sess_deadbeef");
	});

	it("uses the indexed remote thread when resuming its local session ID", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const thread = savedThread("thread_remote");
		const target = await resolveResumeTarget(
			fakeClient([thread]),
			cwd,
			"sess_deadbeef",
			{
				cwd,
				sessionId: "sess_deadbeef",
				threadId: "thread_remote",
				updatedAt: "2026-08-18T10:00:00Z",
			},
		);
		expect(target.thread?.thread_id).toBe("thread_remote");
		expect(target.localSessionId).toBe("sess_deadbeef");
		expect(target.messages).toHaveLength(1);
	});

	it("falls back to a local session when its indexed remote thread is gone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new BackboardError("missing", 404, null);
		};
		const target = await resolveResumeTarget(client, cwd, "sess_deadbeef", {
			cwd,
			sessionId: "sess_deadbeef",
			threadId: "thread_remote",
			updatedAt: "2026-08-18T10:00:00Z",
		});
		expect(target.thread).toBeNull();
		expect(target.localSessionId).toBe("sess_deadbeef");
	});

	it("falls back to a local session when its indexed BYOK thread is gone", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new ByokConversationNotFoundError("byok_deadbeef");
		};
		const target = await resolveResumeTarget(client, cwd, "sess_deadbeef", {
			cwd,
			sessionId: "sess_deadbeef",
			threadId: "byok_deadbeef",
			updatedAt: "2026-08-18T10:00:00Z",
		});
		expect(target.thread).toBeNull();
		expect(target.localSessionId).toBe("sess_deadbeef");
	});

	it("falls back locally when the indexed backend is unavailable", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new BackendUnavailableError({
				provider: "anthropic",
				model: "claude-test",
			});
		};
		const target = await resolveResumeTarget(client, cwd, "sess_deadbeef", {
			cwd,
			sessionId: "sess_deadbeef",
			threadId: "thread_remote",
			updatedAt: "2026-08-18T10:00:00Z",
		});
		expect(target.thread).toBeNull();
		expect(target.localSessionId).toBe("sess_deadbeef");
	});

	it("preserves transient indexed-thread failures", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-session-"));
		await mkdir(qSessionDir(cwd, "sess_deadbeef"), { recursive: true });
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new Error("network unavailable");
		};
		await expect(
			resolveResumeTarget(client, cwd, "sess_deadbeef", {
				cwd,
				sessionId: "sess_deadbeef",
				threadId: "thread_remote",
				updatedAt: "2026-08-18T10:00:00Z",
			}),
		).rejects.toThrow("network unavailable");
	});

	it("rejects unknown IDs", async () => {
		await expect(
			resolveResumeTarget(fakeClient([]), "/tmp/project", "byok_deadbeef"),
		).rejects.toThrow('Session "byok_deadbeef" was not found.');
	});

	it("rejects noncanonical local IDs instead of treating them as remote", async () => {
		await expect(
			resolveResumeTarget(fakeClient([]), "/tmp/project", "SESS_DEADBEEF"),
		).rejects.toThrow("Local session IDs must use lowercase");
	});

	it("fetches a remote thread directly when it falls outside the list window", async () => {
		const thread = savedThread("thread_old");
		const client = fakeClient([]);
		client.listThreads = async () => {
			throw new Error("list should not be called");
		};
		client.getThread = async () => thread;
		expect(
			(await resolveResumeTarget(client, "/tmp/project", "thread_old")).thread
				?.thread_id,
		).toBe("thread_old");
	});

	it("preserves non-404 failures from direct remote lookup", async () => {
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new Error("network unavailable");
		};
		await expect(
			resolveResumeTarget(client, "/tmp/project", "thread_old"),
		).rejects.toThrow("network unavailable");
	});

	it("normalizes remote 404s into the session not-found error", async () => {
		const client = fakeClient([]);
		client.getThread = async () => {
			throw new BackboardError("missing", 404, null);
		};
		await expect(
			resolveResumeTarget(client, "/tmp/project", "thread_old"),
		).rejects.toThrow('Session "thread_old" was not found.');
	});

	it("detects direct resume of the already-active thread", () => {
		expect(isAlreadyActiveResume(" thread_old ", "thread_old")).toBe(true);
		expect(isAlreadyActiveResume("thread_other", "thread_old")).toBe(false);
		expect(isAlreadyActiveResume("thread_old", null)).toBe(false);
		expect(isAlreadyActiveResume("sess_deadbeef", null, "sess_deadbeef")).toBe(
			true,
		);
	});

	it("restores a BYOK model without persisting the global selection", async () => {
		let saved = 0;
		const hydratedThreadIds: string[] = [];
		const thread = savedThread("byok_deadbeef", {
			[BYOK_THREAD_METADATA_KEY]: true,
			[BYOK_SESSION_ID_METADATA_KEY]: "sess_1234abcd",
			model_provider: "anthropic",
			model_name: "claude-test",
		});
		const config = {
			flags: {},
			setModel: () => {},
			saveRuntimeSelection: async () => {
				saved++;
			},
		} as unknown as Config;
		const controller = {
			setModelContextLimit: () => {},
			hydrateSession: (input: { threadId: string }) => {
				hydratedThreadIds.push(input.threadId);
			},
		} as unknown as AgentController;

		await activateResumeTarget(
			{
				displayTitle: "Saved work",
				thread,
				messages: [],
				localSessionId: "sess_1234abcd",
			},
			{
				config,
				controller,
				onResumeLocalSession: async () => {},
			},
		);

		expect(saved).toBe(0);
		expect(hydratedThreadIds).toEqual(["byok_deadbeef"]);
	});

	it("preserves an explicit CLI model while hydrating a BYOK session", async () => {
		let modelChanges = 0;
		let contextResets = 0;
		const thread = savedThread("byok_deadbeef", {
			[BYOK_THREAD_METADATA_KEY]: true,
			[BYOK_SESSION_ID_METADATA_KEY]: "*************",
			model_provider: "anthropic",
			model_name: "claude-test",
		});
		const config = {
			flags: { model: "openai/gpt-test" },
			setModel: () => {
				modelChanges++;
			},
		} as unknown as Config;
		const controller = {
			setModelContextLimit: () => {
				contextResets++;
			},
			hydrateSession: () => {},
		} as unknown as AgentController;

		await activateResumeTarget(
			{
				displayTitle: "Saved work",
				thread,
				messages: [],
				localSessionId: "sess_1234abcd",
			},
			{
				config,
				controller,
				onResumeLocalSession: async () => {},
			},
		);

		expect(modelChanges).toBe(0);
		expect(contextResets).toBe(0);
	});
});

function savedThread(
	threadId: string,
	metadata?: Record<string, unknown>,
): BackboardThread {
	return {
		thread_id: threadId,
		title: "Saved work",
		created_at: "2026-08-17T10:00:00Z",
		updated_at: "2026-08-18T10:00:00Z",
		metadata_: metadata,
		messages: [
			{
				message_id: "message_1",
				role: "user",
				content: "hello",
				created_at: "2026-08-17T10:00:00Z",
			},
		],
	};
}

function fakeClient(threads: BackboardThread[]): AgentClient {
	return {
		listThreads: async () => threads,
		getThread: async (threadId: string) => {
			const thread = threads.find(
				(candidate) => candidate.thread_id === threadId,
			);
			if (!thread) throw new Error("missing");
			return thread;
		},
	} as AgentClient;
}
