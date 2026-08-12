import { describe, expect, it } from "bun:test";
import { Config } from "../src/config/Config.ts";
import { CompactionError, Compactor } from "../src/core/context/Compactor.ts";
import {
	AUTO_COMPACT_THRESHOLD_PERCENT,
	shouldAutoCompact,
} from "../src/core/context/policy.ts";
import { renderTranscript } from "../src/core/context/transcript.ts";
import {
	assistantMessage,
	toolMessage,
	userMessage,
} from "../src/core/session/Message.ts";
import { Session } from "../src/core/session/Session.ts";
import {
	buildResumeContext,
	extractHandoff,
} from "../src/prompts/context/compaction.ts";
import type { AgentClient } from "../src/providers/AgentClient.ts";
import type {
	BackboardResponse,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";

const env = { apiKey: "k", apiUrl: "https://example.test/api" };

function config(): Config {
	return new Config({ env, argv: [] });
}

class FakeSummarizer {
	readonly requests: SendMessageRequest[] = [];

	constructor(private readonly summary: string) {}

	async sendMessage(req: SendMessageRequest): Promise<BackboardResponse> {
		this.requests.push(req);
		return {
			thread_id: "summary_thread",
			content: this.summary,
			status: "COMPLETED",
			tool_calls: null,
		};
	}
}

function populatedSession(): Session {
	const session = new Session("sess_test");
	session.threadId = "thread_original";
	session.assistantId = "asst_original";
	session.addMessage(userMessage("Fix the failing auth test"));
	session.addMessage(
		assistantMessage("Looking at it.", [
			{ id: "call_1", name: "read_file", input: { path: "/repo/auth.ts" } },
		]),
	);
	session.addMessage(
		toolMessage([
			{
				toolCallId: "call_1",
				name: "read_file",
				output: "export function auth() {}",
				isError: false,
			},
		]),
	);
	session.addMessage(assistantMessage("Found the bug in /repo/auth.ts:88."));
	session.addMessage(userMessage("Now add a regression test"));
	session.addMessage(assistantMessage("Added tests/auth.test.ts."));
	return session;
}

function compactor(
	session: Session,
	client: FakeSummarizer,
	transcriptPath?: string,
): Compactor {
	return new Compactor({
		client: client as unknown as AgentClient,
		session,
		config: config(),
		...(transcriptPath ? { transcriptPath } : {}),
	});
}

const HANDOFF = `<handoff>
## Objective
Fix the failing auth test.
## Current State
Bug identified at /repo/auth.ts:88.
</handoff>`;

describe("Compactor", () => {
	it("refuses to compress a conversation that has barely started", async () => {
		const session = new Session("sess_short");
		session.addMessage(userMessage("hi"));

		await expect(
			compactor(session, new FakeSummarizer(HANDOFF)).compact(),
		).rejects.toBeInstanceOf(CompactionError);
	});

	it("summarizes on a throwaway thread with no tools or memory", async () => {
		const client = new FakeSummarizer(HANDOFF);
		await compactor(populatedSession(), client).compact();

		const request = client.requests[0];
		// No thread id: the summarization must not land in the conversation it
		// is compressing.
		expect(request?.thread_id).toBeUndefined();
		expect(request?.tools).toEqual([]);
		expect(request?.memory).toBe("off");
		expect(request?.content).toContain("Fix the failing auth test");
	});

	it("resets the thread so the next turn starts fresh", async () => {
		const session = populatedSession();
		await compactor(session, new FakeSummarizer(HANDOFF)).compact();

		expect(session.threadId).toBeNull();
		expect(session.getMessages()).toHaveLength(0);
	});

	it("carries the todo list through compression", async () => {
		const session = populatedSession();
		session.setTodos([
			{ id: "1", content: "Add regression test", status: "in_progress" },
		]);

		await compactor(session, new FakeSummarizer(HANDOFF)).compact();

		// Todos are live working state, not history - losing them would drop the
		// agent's own plan mid-task.
		expect(session.todos).toEqual([
			{ id: "1", content: "Add regression test", status: "in_progress" },
		]);
	});

	it("returns resume context holding both the handoff and the verbatim tail", async () => {
		const result = await compactor(
			populatedSession(),
			new FakeSummarizer(HANDOFF),
		).compact();

		expect(result.handoff).toContain("Bug identified at /repo/auth.ts:88.");
		expect(result.resumeContext).toContain(
			"Bug identified at /repo/auth.ts:88.",
		);
		expect(result.resumeContext).toContain("Now add a regression test");
		expect(result.resumeContext).toContain("carry on");
		expect(result.verbatimKept).toBeGreaterThan(0);
	});

	it("never lets the verbatim tail swallow the whole history", async () => {
		const client = new FakeSummarizer(HANDOFF);
		// Six messages with a six-message tail would leave nothing to summarize.
		const result = await compactor(populatedSession(), client).compact();

		expect(client.requests[0]?.content).toContain("Fix the failing auth test");
		expect(result.messagesCompacted).toBeGreaterThan(0);
		expect(result.verbatimKept).toBeLessThan(6);
	});

	// A summary is lossy by construction; the transcript is the fallback for
	// whatever it dropped, and the agent can only use it if it is told where.
	it("points the resumed agent at the full transcript on disk", async () => {
		const result = await compactor(
			populatedSession(),
			new FakeSummarizer(HANDOFF),
			"/repo/.backboard/sessions/sess_1/client.jsonl",
		).compact();

		expect(result.resumeContext).toContain(
			"/repo/.backboard/sessions/sess_1/client.jsonl",
		);
		expect(result.transcriptPath).toBe(
			"/repo/.backboard/sessions/sess_1/client.jsonl",
		);
	});

	it("omits the transcript pointer when there is no log to point at", async () => {
		const result = await compactor(
			populatedSession(),
			new FakeSummarizer(HANDOFF),
		).compact();

		expect(result.resumeContext).not.toContain("transcript of everything");
	});

	it("rejects a backend error returned as summary content", async () => {
		// A backend can answer HTTP 200 with an error string in `content`
		// (unsupported model, quota). Accepting it would swap real history for
		// an error message.
		const session = populatedSession();
		await expect(
			compactor(
				session,
				new FakeSummarizer("LLM Error: Model 'x' is not supported."),
			).compact(),
		).rejects.toBeInstanceOf(CompactionError);
		expect(session.getMessages()).toHaveLength(6);
		expect(session.threadId).toBe("thread_original");
	});

	it("fails loudly rather than silently discarding history on an empty summary", async () => {
		const session = populatedSession();
		await expect(
			compactor(session, new FakeSummarizer("   ")).compact(),
		).rejects.toBeInstanceOf(CompactionError);
		// The conversation must survive a failed compression intact.
		expect(session.getMessages()).toHaveLength(6);
		expect(session.threadId).toBe("thread_original");
	});
});

describe("transcript rendering", () => {
	it("keeps the newest exchanges verbatim and summarizes the rest", () => {
		const session = populatedSession();
		const rendered = renderTranscript(session.getMessages(), {
			verbatimTailMessages: 2,
		});

		expect(rendered.verbatimCount).toBe(2);
		expect(rendered.verbatimTail).toContain("Now add a regression test");
		expect(rendered.transcript).toContain("Fix the failing auth test");
		expect(rendered.transcript).not.toContain("Now add a regression test");
	});

	it("clamps the summarized region hard and the tail only loosely", () => {
		const session = new Session("sess_long");
		const huge = "x".repeat(20_000);
		session.addMessage(userMessage("run it"));
		session.addMessage(
			toolMessage([
				{ toolCallId: "c1", name: "execute", output: huge, isError: false },
			]),
		);
		session.addMessage(userMessage("and again"));
		session.addMessage(
			toolMessage([
				{ toolCallId: "c2", name: "execute", output: huge, isError: false },
			]),
		);

		const rendered = renderTranscript(session.getMessages(), {
			verbatimTailMessages: 2,
		});

		expect(rendered.transcript).toContain("characters omitted");
		expect(rendered.transcript.length).toBeLessThan(5_000);
		// The tail keeps the live edge nearly whole, but not without bound: a
		// single huge result must not survive verbatim into the next prompt.
		expect(rendered.verbatimTail).not.toContain(huge);
		expect(rendered.verbatimTail).toContain("characters omitted");
		expect(rendered.verbatimTail.length).toBeGreaterThan(17_000);
	});

	it("leaves ordinary tail output untouched", () => {
		const session = new Session("sess_small_tail");
		const output = "y".repeat(2_000);
		session.addMessage(userMessage("run it"));
		session.addMessage(
			toolMessage([
				{ toolCallId: "c1", name: "execute", output, isError: false },
			]),
		);

		const rendered = renderTranscript(session.getMessages(), {
			verbatimTailMessages: 2,
		});

		expect(rendered.verbatimTail).toContain(output);
	});
});

describe("handoff extraction", () => {
	it("pulls the document out of its tags", () => {
		expect(extractHandoff("noise <handoff>\nbody\n</handoff> more")).toBe(
			"body",
		);
	});

	it("recovers a document whose closing tag was truncated", () => {
		expect(extractHandoff("<handoff>\nbody that ran long")).toBe(
			"body that ran long",
		);
	});

	it("falls back to the whole reply when the model omits tags entirely", () => {
		expect(extractHandoff("  just a summary  ")).toBe("just a summary");
	});

	it("tells the agent the handoff is its own memory, not a user message", () => {
		const context = buildResumeContext("HANDOFF BODY", "TAIL");
		expect(context).toContain("treat it as established fact");
		expect(context).toContain("HANDOFF BODY");
		expect(context).toContain("TAIL");
		expect(context).toContain("Do not summarize this back to the user");
	});
});

describe("auto-compaction policy", () => {
	const base = { limit: 200_000, messageCount: 20 };

	it("fires once the window crosses the threshold", () => {
		expect(shouldAutoCompact({ ...base, usedTokens: 170_000 })).toBe(true);
		expect(shouldAutoCompact({ ...base, usedTokens: 169_000 })).toBe(false);
	});

	it("uses 85 percent by default", () => {
		expect(AUTO_COMPACT_THRESHOLD_PERCENT).toBe(85);
	});

	it("stays quiet before any turn has been measured", () => {
		expect(shouldAutoCompact({ ...base, usedTokens: 0 })).toBe(false);
	});

	it("does not fire on a short conversation with one huge prompt", () => {
		// A single enormous message is not a history problem, so compressing
		// history would not help.
		expect(
			shouldAutoCompact({ ...base, usedTokens: 190_000, messageCount: 2 }),
		).toBe(false);
	});

	it("honours an explicit threshold", () => {
		expect(
			shouldAutoCompact({
				...base,
				usedTokens: 120_000,
				thresholdPercent: 50,
			}),
		).toBe(true);
	});
});
