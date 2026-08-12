import { describe, expect, it } from "bun:test";
import type {
	CheckpointCallContext,
	CheckpointRecorder,
} from "../src/core/checkpoints/CheckpointStore.ts";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { makeContext } from "./helpers.ts";

/** Recorder that logs shell-capture calls instead of touching disk. */
function makeRecorder(): { recorder: CheckpointRecorder; calls: string[] } {
	const calls: string[] = [];
	const recorder: CheckpointRecorder = {
		recordPreImage: async () => {
			calls.push("pre");
		},
		recordPostImage: async () => {
			calls.push("post");
		},
		revertToolCall: async () => {
			calls.push("revert");
		},
		beginShellCapture: async (_cwd, ctx: CheckpointCallContext) => {
			calls.push(`begin:${ctx.toolCallId ?? "?"}`);
		},
		endShellCapture: async (ctx: CheckpointCallContext) => {
			calls.push(`end:${ctx.toolCallId ?? "?"}`);
		},
		captureWarning: () => null,
		scopedToTurn: () => recorder,
	};
	return { recorder, calls };
}

describe("ExecuteTool shell capture wiring", () => {
	it("wraps a command in begin/end exactly once", async () => {
		const tool = new ExecuteTool();
		const { recorder, calls } = makeRecorder();
		const ctx = {
			...makeContext(new AbortController().signal),
			toolCallId: "tc1",
			checkpoints: recorder,
		};
		const result = await tool.execute({ command: "echo captured" }, ctx);
		expect(result.data.stdout?.trim()).toBe("captured");
		expect(calls).toEqual(["begin:tc1", "end:tc1"]);
	}, 10_000);

	it("still ends capture when the command fails", async () => {
		const tool = new ExecuteTool();
		const { recorder, calls } = makeRecorder();
		const ctx = {
			...makeContext(new AbortController().signal),
			toolCallId: "tc2",
			checkpoints: recorder,
		};
		const result = await tool.execute({ command: "exit 3" }, ctx);
		expect(result.data.exitCode).toBe(3);
		expect(calls).toEqual(["begin:tc2", "end:tc2"]);
	}, 10_000);

	it("skips capture entirely for fire-and-forget commands", async () => {
		const tool = new ExecuteTool();
		const { recorder, calls } = makeRecorder();
		const ctx = {
			...makeContext(new AbortController().signal),
			toolCallId: "tc3",
			checkpoints: recorder,
		};
		const result = await tool.execute(
			{ command: "echo bg", fireAndForget: true },
			ctx,
		);
		expect(result.data.fireAndForget).toBe(true);
		expect(calls).toEqual([]);
	}, 10_000);
});
