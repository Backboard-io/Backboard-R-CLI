import { describe, expect, it } from "bun:test";
import type { RenderTranscriptItem } from "../src/state/AppState.ts";
import { groupConsecutiveToolItems } from "../src/state/toolGrouping.ts";

describe("groupConsecutiveToolItems", () => {
	it("stacks adjacent completed calls with the same tool name", () => {
		const items: RenderTranscriptItem[] = [
			tool("read_1", "Read", "file 1"),
			tool("read_2", "Read", "file 2"),
			tool("grep_1", "Grep", "pattern"),
		];

		const grouped = groupConsecutiveToolItems(items);

		expect(grouped).toHaveLength(2);
		expect(grouped[0]).toMatchObject({
			kind: "tool_group",
			name: "Read",
		});
		const first = grouped[0];
		if (first?.kind !== "tool_group") {
			throw new Error("Expected first item to be a tool group.");
		}
		expect(first.items.map((item) => item.inputSummary)).toEqual([
			"file 1",
			"file 2",
		]);
		expect(grouped[1]).toMatchObject({ kind: "tool", name: "Grep" });
	});

	it("does not group across other transcript items", () => {
		const grouped = groupConsecutiveToolItems([
			tool("read_1", "Read", "file 1"),
			{ kind: "notice", id: "notice_1", level: "info", text: "break" },
			tool("read_2", "Read", "file 2"),
		]);

		expect(grouped.map((item) => item.kind)).toEqual([
			"tool",
			"notice",
			"tool",
		]);
	});

	it("groups errored calls with done ones but never running calls", () => {
		const grouped = groupConsecutiveToolItems([
			tool("read_1", "Read", "file 1", "running"),
			tool("read_2", "Read", "file 2", "done"),
			tool("read_3", "Read", "file 3", "error"),
		]);

		expect(grouped.map((item) => item.kind)).toEqual(["tool", "tool_group"]);
		const group = grouped[1];
		if (group?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(group.items.map((item) => item.id)).toEqual(["read_2", "read_3"]);
	});

	it("groups same-name calls in one batch even when another tool sits between", () => {
		const grouped = groupConsecutiveToolItems([
			tool("read_1", "Read", "file 1"),
			tool("grep_1", "Grep", "pattern"),
			tool("read_2", "Read", "file 2"),
			tool("grep_2", "Grep", "pattern 2"),
		]);

		expect(grouped.map((item) => item.kind)).toEqual([
			"tool_group",
			"tool_group",
		]);
		const reads = grouped[0];
		if (reads?.kind !== "tool_group") throw new Error("expected tool_group");
		expect(reads.name).toBe("Read");
		expect(reads.items.map((item) => item.id)).toEqual(["read_1", "read_2"]);
	});
});

function tool(
	id: string,
	name: string,
	inputSummary: string,
	status: "running" | "done" | "error" = "done",
): RenderTranscriptItem {
	return {
		kind: "tool",
		id,
		name,
		inputSummary,
		status,
	};
}
