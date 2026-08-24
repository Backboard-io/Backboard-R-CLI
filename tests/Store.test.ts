import { describe, expect, it } from "bun:test";
import {
	assistantMessage,
	type Message,
	toolMessage,
	userMessage,
} from "../src/core/session/Message.ts";
import { initialState } from "../src/state/AppState.ts";
import { reduce, transcriptFromMessages } from "../src/state/Store.ts";

describe("Store reducer", () => {
	it("omits empty assistant placeholders from hydrated transcripts", () => {
		const transcript = transcriptFromMessages([
			userMessage("hi"),
			assistantMessage("", [{ id: "call_1", name: "Read", input: {} }]),
			toolMessage([
				{
					toolCallId: "call_1",
					name: "Read",
					output: "done",
					isError: false,
				},
			]),
			assistantMessage("done"),
		]);

		expect(transcript.map((item) => item.kind)).toEqual([
			"user",
			"tool",
			"assistant",
		]);
	});

	it("renders hydrated tool results with input summaries and output titles", () => {
		const transcript = transcriptFromMessages([
			assistantMessage("", [
				{ id: "call_1", name: "read", input: { file_path: "/x/notes.md" } },
			]),
			toolMessage([
				{
					toolCallId: "call_1",
					name: "read",
					output: "line one\nline two",
					isError: false,
				},
			]),
		]);

		expect(transcript).toEqual([
			{
				kind: "tool",
				id: "history-tool-1-0",
				name: "Read",
				inputSummary: "/x/notes.md",
				status: "done",
				title: "line one …",
			},
		]);
	});

	it("renders one row per hydrated tool result and marks errors", () => {
		const transcript = transcriptFromMessages([
			assistantMessage("", [
				{ id: "call_1", name: "execute", input: { command: "bun test" } },
				{ id: "call_2", name: "grep", input: { pattern: "todo" } },
			]),
			toolMessage([
				{
					toolCallId: "call_1",
					name: "execute",
					output: "12 tests passed",
					isError: false,
				},
				{
					toolCallId: "call_2",
					name: "grep",
					output: "Error: bad pattern",
					isError: true,
				},
			]),
		]);

		expect(transcript).toEqual([
			{
				kind: "tool",
				id: "history-tool-1-0",
				name: "Execute",
				inputSummary: "bun test",
				status: "done",
				title: "12 tests passed",
			},
			{
				kind: "tool",
				id: "history-tool-1-1",
				name: "Grep",
				inputSummary: "todo",
				status: "error",
				error: "Error: bad pattern",
			},
		]);
	});

	it("ignores unknown hydrated message roles", () => {
		const messages = [
			{ role: "system", text: "ignored" },
			userMessage("hi"),
		] as unknown as readonly Message[];

		const transcript = transcriptFromMessages(messages);

		expect(transcript.map((item) => item.kind)).toEqual(["user"]);
	});

	it("attaches turn duration to assistant messages when the turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "done",
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 81_000,
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("assistant");
		if (item?.kind !== "assistant") throw new Error("expected assistant item");
		expect(item.durationMs).toBe(81_000);
	});

	it("keeps streamed assistant segments in chronological order around tools", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first",
		});
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:1",
			text: "second",
		});

		expect(state.transcript.map((item) => item.kind)).toEqual([
			"assistant",
			"tool",
			"assistant",
		]);
	});

	it("stores tool result detail for transcript rendering", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Edit",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Edit",
			title: "Applied 1 replacement",
			detail: "--- a.ts\n+++ a.ts\n@@\n- old\n+ new",
		});

		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "done",
			title: "Applied 1 replacement",
			detail: "--- a.ts\n+++ a.ts\n@@\n- old\n+ new",
		});
	});

	it("stores typed tool result detail lines for transcript rendering", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Edit",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Edit",
			title: "Applied 1 replacement",
			detailLines: [
				{ key: "old", displayValue: "- old", highlighted: true },
				{ key: "new", displayValue: "+ new", highlighted: true },
			],
		});

		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "done",
			title: "Applied 1 replacement",
			detailLines: [
				{ key: "old", displayValue: "- old", highlighted: true },
				{ key: "new", displayValue: "+ new", highlighted: true },
			],
		});
	});

	it("does not render TodoWrite as a transcript tool row", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "todo_call",
			name: "TodoWrite",
			inputSummary: "",
		});
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "in_progress" }],
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "todo_call",
			name: "TodoWrite",
			title: "Updated 1 todos · 0 completed",
		});

		expect(state.transcript).toEqual([]);
		expect(state.render.liveItems).toEqual([]);
		expect(state.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "in_progress" },
		]);
	});

	it("surfaces TodoWrite errors even though successful updates are hidden", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "todo_call",
			name: "TodoWrite",
			inputSummary: "",
		});
		state = reduce(state, {
			type: "tool:error",
			toolCallId: "todo_call",
			name: "TodoWrite",
			error: "TodoWrite accepts at most one in_progress todo.",
		});

		expect(state.transcript).toEqual([
			{
				kind: "notice",
				id: expect.stringMatching(/^n_/),
				level: "error",
				text: "TodoWrite failed: TodoWrite accepts at most one in_progress todo.",
			},
		]);
		expect(state.render.staticItems).toEqual(state.transcript);
		expect(state.render.liveItems).toEqual([]);
	});

	it("keeps completed todos visible after a turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 1_000,
		});

		expect(state.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "completed" },
		]);
	});

	it("clears completed todos when the next turn starts", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		state = reduce(state, {
			type: "turn:start",
			turnId: "turn_2",
		});

		expect(state.todos).toEqual([]);
	});

	it("finalizes running tool calls when the turn is cancelled", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Execute",
			inputSummary: "npm run dev",
		});
		state = reduce(state, { type: "turn:cancelled", turnId: "turn_1" });

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "error", error: "Interrupted" },
		]);
		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "error",
			error: "Interrupted",
		});
	});

	it("ignores tool events that land after the turn was cancelled", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Execute",
			inputSummary: "npm run dev",
		});
		state = reduce(state, { type: "turn:cancelled", turnId: "turn_1" });
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Execute",
			title: "Success",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "error", error: "Interrupted" },
		]);
		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "error",
			error: "Interrupted",
		});
	});

	it("ignores a late tool:start after the turn was cancelled", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_1",
			name: "Execute",
			inputSummary: "npm run dev",
		});
		state = reduce(state, { type: "turn:cancelled", turnId: "turn_1" });
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Execute",
			inputSummary: "npm run dev",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "error", error: "Interrupted" },
		]);
		expect(state.transcript[0]).toMatchObject({
			kind: "tool",
			status: "error",
			error: "Interrupted",
		});
	});

	it("ignores child tool events for a cancelled Agent call", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "agent_1",
			name: "Subagent",
			inputSummary: "research the codebase",
		});
		state = reduce(state, { type: "turn:cancelled", turnId: "turn_1" });
		state = reduce(state, {
			type: "agent:child_tool_start",
			agentToolCallId: "agent_1",
			call: {
				id: "child_1",
				name: "Read",
				inputSummary: "src/index.ts",
				status: "running",
			},
		});
		state = reduce(state, {
			type: "agent:child_tool_result",
			agentToolCallId: "agent_1",
			childToolCallId: "child_1",
			status: "done",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "agent_1", status: "error", error: "Interrupted" },
		]);
	});

	it("commits complete lines and hides the in-progress tail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first line\nsecond",
		});

		expect(state.render.staticItems).toMatchObject([
			{
				kind: "assistant_chunk",
				text: "first line\n",
				showHeader: true,
			},
		]);
		// Per-line streaming: the partial "second" is held in the stream, not rendered live.
		expect(
			state.render.liveItems.some((item) => item.kind === "assistant_chunk"),
		).toBe(false);
		expect(state.render.assistantStreams[0]?.pendingText).toBe("second");
	});

	it("preserves static item identity while a delta remains buffered", () => {
		const state = initialState("gpt-test");
		const next = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "partial",
		});

		expect(next.render.staticItems).toBe(state.render.staticItems);
	});

	it("commits long no-newline streaming progressively and bounds the pending tail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: `${"word ".repeat(220)}tail`,
		});

		expect(state.render.staticItems[0]?.kind).toBe("assistant_chunk");
		expect(
			state.render.liveItems.some((item) => item.kind === "assistant_chunk"),
		).toBe(false);
		expect(
			state.render.assistantStreams[0]?.pendingText.length ?? 0,
		).toBeLessThanOrEqual(500);
	});

	it("holds an in-progress table in the pending tail instead of splitting it across chunks", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "Here is a table:\n\n| Name | Score |\n| --- | --- |\n| Alice | 92 |\n",
		});

		// The intro line flushes normally; the open table (no blank line has
		// closed it yet) stays buffered rather than being committed row by row.
		expect(state.render.staticItems).toMatchObject([
			{ kind: "assistant_chunk", text: "Here is a table:\n\n" },
		]);
		expect(state.render.assistantStreams[0]?.pendingText).toBe(
			"| Name | Score |\n| --- | --- |\n| Alice | 92 |\n",
		);

		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "| Bob | 88 |\n\ndone",
		});

		// Once a blank line closes the table, the whole thing flushes as one chunk.
		expect(state.render.staticItems).toMatchObject([
			{ kind: "assistant_chunk", text: "Here is a table:\n\n" },
			{
				kind: "assistant_chunk",
				text: "| Name | Score |\n| --- | --- |\n| Alice | 92 |\n| Bob | 88 |\n\n",
			},
		]);
		expect(state.render.assistantStreams[0]?.pendingText).toBe("done");
	});

	it("holds a table past the live char cap instead of slicing it mid-body", () => {
		let state = initialState("gpt-test");
		const delta = (text: string) =>
			reduce(state, {
				type: "assistant:delta",
				turnId: "turn_1",
				messageId: "turn_1:assistant:0",
				text,
			});
		state = delta(
			"| City | Weather | Temp | Feels like | Humidity | Wind |\n| --- | --- | --- | --- | --- | --- |\n",
		);
		for (let row = 0; row < 20; row++) {
			state = delta(
				`| City ${row}, Country ${row} | Partly cloudy | 2${row % 10}.5 | 3${row % 10}.1 | 9${row % 10}% | 1${row % 10}.3 |\n`,
			);
		}

		// Well past MAX_LIVE_ASSISTANT_CHARS, but still one open table: nothing
		// may flush, or the tail rows would render as headerless pipe text.
		expect(state.render.staticItems).toEqual([]);

		state = delta("\nHottest: City 5.");

		const chunks = state.render.staticItems.filter(
			(item) => item.kind === "assistant_chunk",
		);
		expect(chunks).toHaveLength(1);
		const text = chunks[0]?.kind === "assistant_chunk" ? chunks[0].text : "";
		expect(text).toContain("| --- |");
		expect(text).toContain("| City 0,");
		expect(text).toContain("| City 19,");
	});

	it("finalizes assistant stream into static transcript and appends footer", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "assistant:delta",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first\nsec",
		});
		state = reduce(state, {
			type: "assistant:message",
			turnId: "turn_1",
			messageId: "turn_1:assistant:0",
			text: "first\nsecond",
		});
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 61_000,
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems.map((item) => item.kind)).toEqual([
			"assistant_chunk",
			"assistant_chunk",
			"assistant_footer",
		]);
		expect(state.render.staticItems[1]).toMatchObject({
			kind: "assistant_chunk",
			text: "second",
			showHeader: false,
		});
	});

	it("keeps running tool live until final result is committed", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});

		expect(state.render.staticItems).toEqual([]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
		]);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
		]);
	});

	it("a re-announced pending event cannot resurrect a completed tool row", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		// The done row drained out of the live region.
		expect(state.render.liveItems).toEqual([]);

		// A stream retry re-announces the same call id. The transcript keeps
		// the done row - and the live region must not grow a pending spinner
		// for a tool that already rendered its result.
		const next = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		expect(next).toBe(state);
	});

	it("a finalize re-run cannot resurrect a drained early-run tool row", () => {
		// An early-dispatched read completes fast and its done row drains to
		// static scrollback; the authoritative round then arrives with
		// different args, so the scheduler aborts the settled early run and
		// re-runs the call - re-emitting tool:start and tool:result for the
		// same id. Neither may revive the drained row or drain a duplicate.
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toHaveLength(1);

		const afterStart = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "b.ts",
		});
		expect(afterStart).toBe(state);

		const afterResult = reduce(afterStart, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 20 lines",
		});
		expect(afterResult).toBe(state);
		expect(afterResult.render.staticItems).toHaveLength(1);
	});

	it("retraction drops unfinished tool rows but never completed ones", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Grep",
			inputSummary: "foo",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_3",
			name: "Read",
			inputSummary: "b.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_3",
			name: "Read",
			title: "Read 10 lines",
		});

		// pending and running rows retract (their call will never resolve)...
		state = reduce(state, { type: "tool:retracted", toolCallId: "call_1" });
		state = reduce(state, { type: "tool:retracted", toolCallId: "call_2" });
		// ...but a stray retraction for a completed row is ignored - it may
		// already have drained to static scrollback and can't be un-printed.
		state = reduce(state, { type: "tool:retracted", toolCallId: "call_3" });

		expect(
			state.transcript.filter((item) => item.kind === "tool"),
		).toMatchObject([{ id: "call_3", status: "done" }]);
	});

	it("shows a pending round immediately and upserts rows in place", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:pending",
			toolCallId: "call_2",
			name: "Write",
			inputSummary: "b.ts",
		});

		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "pending" },
			{ kind: "tool", id: "call_2", status: "pending" },
		]);

		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});

		// Upserted, not duplicated - and order preserved.
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
			{ kind: "tool", id: "call_2", status: "pending" },
		]);
		expect(
			state.transcript.filter(
				(item) => item.kind === "tool" && item.id === "call_1",
			),
		).toHaveLength(1);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		// The finished head call drains to static; the pending sibling stays
		// live (a pending row must never be committed to <Static>).
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
		]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_2", status: "pending" },
		]);
	});

	it("commits parallel tools in start order", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Grep",
			inputSummary: "needle",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Grep",
			title: "Found 2 matches",
		});

		expect(state.render.staticItems).toEqual([]);
		expect(state.render.liveItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "running" },
			{ kind: "tool", id: "call_2", status: "done" },
		]);

		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.liveItems).toEqual([]);
		expect(state.render.staticItems).toMatchObject([
			{ kind: "tool", id: "call_1", status: "done" },
			{ kind: "tool", id: "call_2", status: "done" },
		]);
	});

	it("preserves Agent reports as transcript detail", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Agent",
			inputSummary: "inspect",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Agent",
			title: "Agent rlm (2 rounds)",
			agentOutput: {
				mode: "rlm",
				status: "completed",
				rounds: 2,
				tracePath: ".backboard/sessions/s/agents/call_1",
				report: "Found the relevant files and summarized them.",
			},
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected tool item");
		expect(item.title).toBe("Agent rlm (2 rounds)");
		expect(item.detail).toContain("mode: rlm");
		expect(item.detail).toContain("trace: .backboard/sessions/s/agents/call_1");
		expect(item.detail).toContain("Found the relevant files");
	});

	it("previews long Agent reports instead of emitting a raw slice", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Agent",
			inputSummary: "inspect",
		});
		const report = Array.from(
			{ length: 60 },
			(_, i) => `line ${i} ${"x".repeat(300)}`,
		).join("\n");
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Agent",
			title: "Agent worker (3 rounds)",
			agentOutput: {
				mode: "worker",
				status: "completed",
				rounds: 3,
				report,
			},
		});

		const item = state.transcript[0];
		if (item?.kind !== "tool") throw new Error("expected tool item");
		const lines = (item.detail ?? "").split("\n");
		// meta line + capped report lines + the "more lines" footer
		expect(lines).toHaveLength(26);
		expect(lines[0]).toContain("mode: worker");
		expect(lines.at(-1)).toBe("… +36 more lines");
		for (const line of lines.slice(1)) {
			expect(line.length).toBeLessThanOrEqual(96);
		}
	});

	it("tracks live child tool calls under running Agent rows", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "agent_1",
			name: "Agent",
			inputSummary: "inspect",
			agentMode: "worker",
		});
		state = reduce(state, {
			type: "agent:child_tool_start",
			agentToolCallId: "agent_1",
			call: {
				id: "child_1",
				name: "Read",
				inputSummary: "src/a.ts",
				status: "running",
			},
		});
		state = reduce(state, {
			type: "agent:child_tool_result",
			agentToolCallId: "agent_1",
			childToolCallId: "child_1",
			status: "done",
		});

		const item = state.render.liveItems.find(
			(candidate) => candidate.kind === "tool" && candidate.id === "agent_1",
		);
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected Agent tool item");
		expect(item.agentMode).toBe("worker");
		expect(item.childToolCalls).toEqual([
			{
				id: "child_1",
				name: "Read",
				inputSummary: "src/a.ts",
				status: "done",
			},
		]);
	});

	it("keeps non-Agent tool results compact", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		const item = state.transcript[0];
		expect(item?.kind).toBe("tool");
		if (item?.kind !== "tool") throw new Error("expected tool item");
		expect(item.detail).toBeUndefined();
	});

	it("groups parallel same-name tools drained in one batch into a tool_group", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		// call_2 finishes first, so nothing drains until call_1 completes and
		// both are drained (and grouped) in the same batch.
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});

		expect(state.render.staticItems).toHaveLength(1);
		const group = state.render.staticItems[0];
		expect(group?.kind).toBe("tool_group");
		if (group?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(group.items.map((item) => item.inputSummary)).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("holds a completed tool live while a parallel same-name call runs, then groups both", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		// call_1 finishes while call_2 is still running: it must stay live so
		// the pair can drain together and collapse into one grouped entry.
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		expect(state.render.liveItems).toHaveLength(2);
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});

		expect(state.render.liveItems).toHaveLength(0);
		expect(state.render.staticItems).toHaveLength(1);
		const group = state.render.staticItems[0];
		if (group?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(group.items.map((item) => item.inputSummary)).toEqual([
			"a.ts",
			"b.ts",
		]);
	});

	it("force-drains held tools when the turn ends", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		expect(state.render.staticItems).toHaveLength(0);
		state = reduce(state, {
			type: "turn:end",
			turnId: "turn_1",
			status: "completed",
			durationMs: 1_000,
		});

		// call_1 drains even though call_2 never completed.
		expect(
			state.render.staticItems.some(
				(item) => item.kind === "tool" && item.id === "call_1",
			),
		).toBe(true);
	});

	it("never rewrites already-drained static items when a later same-name tool completes", () => {
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_1",
			name: "Read",
			inputSummary: "a.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_1",
			name: "Read",
			title: "Read 10 lines",
		});
		const drainedFirst = state.render.staticItems;
		expect(drainedFirst).toHaveLength(1);

		state = reduce(state, {
			type: "tool:start",
			toolCallId: "call_2",
			name: "Read",
			inputSummary: "b.ts",
		});
		state = reduce(state, {
			type: "tool:result",
			toolCallId: "call_2",
			name: "Read",
			title: "Read 20 lines",
		});

		// Append-only: the first entry must be untouched and the second must be
		// a new entry (Ink's <Static> never re-renders printed items).
		expect(state.render.staticItems).toHaveLength(2);
		expect(state.render.staticItems[0]).toBe(drainedFirst[0]);
		expect(state.render.staticItems[1]).toMatchObject({
			kind: "tool",
			id: "call_2",
		});
	});
});
