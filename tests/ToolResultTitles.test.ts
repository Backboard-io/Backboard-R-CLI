import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToString } from "ink";
import React from "react";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { AskUserTool } from "../src/tools/AskUserTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { buildEditDiffDetailLines } from "../src/tools/fileEdits/diffPreview.ts";
import {
	diffDetailBlockWidth,
	ToolResultView,
} from "../src/ui/components/ToolResultView.tsx";

function context(cwd: string, askUser: ToolContext["askUser"]): ToolContext {
	return {
		sessionId: "sess_test",
		cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser,
	};
}

describe("tool result titles", () => {
	it("shows the selected AskUser option as the result", async () => {
		const result = await new AskUserTool().execute(
			{
				questions: [
					{
						header: "Pick",
						question: "Choose one",
						options: ["Alpha", "Beta"],
					},
				],
			},
			context(process.cwd(), async () => "Beta"),
		);

		expect(result.title).toBe("Selected: Beta");
	});

	it("shows typed AskUser answers separately from selected options", async () => {
		const result = await new AskUserTool().execute(
			{
				questions: [
					{
						header: "Pick",
						question: "Choose one",
						options: ["Alpha", "Beta"],
					},
				],
			},
			context(process.cwd(), async () => "Custom answer"),
		);

		expect(result.title).toBe("Answered: Custom answer");
	});

	it("summarizes multiple AskUser answers as a count", async () => {
		const answers = ["Beta", "Two"];
		let index = 0;
		const result = await new AskUserTool().execute(
			{
				questions: [
					{
						header: "Pick",
						question: "Choose one",
						options: ["Alpha", "Beta"],
					},
					{ header: "Count", question: "How many", options: ["One", "Two"] },
				],
			},
			context(process.cwd(), async () => answers[index++] ?? ""),
		);

		expect(result.title).toBe("Answered 2 questions");
		expect(result.data.answers).toEqual([
			{ header: "Pick", question: "Choose one", answer: "Beta" },
			{ header: "Count", question: "How many", answer: "Two" },
		]);
	});

	it("summarizes changed lines and returns a compact edit diff", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "q-cli-edit-"));
		const filePath = "sample.txt";
		await writeFile(join(cwd, filePath), "hello\nworld\n", "utf8");

		const result = await new EditTool().execute(
			{
				file_path: filePath,
				edits: [{ old_str: "hello", new_str: "hi" }],
			},
			context(cwd, async () => ""),
		);

		expect(result.title).toBe("Changed +1, -1 lines");
		expect(result.detail).toBeUndefined();
		expect(result.detailLines).toEqual([
			{
				key: "header",
				displayValue: "old new │",
				highlighted: false,
				kind: "neutral",
			},
			{
				key: "hunk:0",
				displayValue: "  1     │ @@ sample.txt",
				highlighted: false,
				kind: "neutral",
			},
			{
				key: "line:0",
				displayValue: "  1     │ hello",
				highlighted: true,
				kind: "removed",
			},
			{
				key: "line:1",
				displayValue: "      1 │ hi",
				highlighted: true,
				kind: "added",
			},
			{
				key: "line:2",
				displayValue: "  2   2 │ world",
				highlighted: false,
				kind: "neutral",
			},
		]);
		await expect(readFile(join(cwd, filePath), "utf8")).resolves.toBe(
			"hi\nworld\n",
		);
	});

	it("counts all replacement lines for replace_all edits", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "q-cli-edit-all-"));
		const filePath = "sample.txt";
		await writeFile(join(cwd, filePath), "one\none\n", "utf8");

		const result = await new EditTool().execute(
			{
				file_path: filePath,
				edits: [
					{
						old_str: "one",
						new_str: "two\nthree",
						replace_all: true,
					},
				],
			},
			context(cwd, async () => ""),
		);

		expect(result.title).toBe("Changed +4, -2 lines");
		expect(result.detail).toBeUndefined();
		expect(result.detailLines?.some((line) => line.kind === "added")).toBe(
			true,
		);
		expect(result.detailLines?.some((line) => line.kind === "removed")).toBe(
			true,
		);
		await expect(readFile(join(cwd, filePath), "utf8")).resolves.toBe(
			"two\nthree\ntwo\nthree\n",
		);
	});

	it("truncates large edit diffs", () => {
		const original = Array.from(
			{ length: 30 },
			(_, index) => `old ${index + 1}`,
		)
			.join("\n")
			.concat("\n");
		const updated = Array.from({ length: 30 }, (_, index) => `new ${index + 1}`)
			.join("\n")
			.concat("\n");

		const lines = buildEditDiffDetailLines("large.txt", original, updated, {
			maxLines: 8,
		});

		expect(lines.length).toBeLessThanOrEqual(10);
		expect(lines.at(-1)?.displayValue).toContain("changed line(s) hidden");
		expect(lines.some((line) => line.displayValue.includes("+"))).toBe(false);
		expect(lines.some((line) => line.displayValue.includes("-"))).toBe(false);
	});

	it("expands tabs so diff rows align with their highlight background", () => {
		const original = "const a = 1;\n";
		const updated = "const a = 1;\n\t\tif (a) {\n\t\t\tgo();\n\t\t}\n";

		const lines = buildEditDiffDetailLines("tabs.ts", original, updated);

		expect(lines.some((line) => line.displayValue.includes("\t"))).toBe(false);
		expect(lines).toContainEqual({
			key: "line:1",
			displayValue: "      2 │         if (a) {",
			highlighted: true,
			kind: "added",
		});
		expect(lines).toContainEqual({
			key: "line:2",
			displayValue: "      3 │             go();",
			highlighted: true,
			kind: "added",
		});
	});

	it("shows final newline only edits in compact edit diffs", () => {
		const removed = buildEditDiffDetailLines("newline.txt", "value\n", "value");
		const added = buildEditDiffDetailLines("newline.txt", "value", "value\n");

		expect(removed).toContainEqual({
			key: "line:1",
			displayValue: "  2     │ \\ Final newline",
			highlighted: true,
			kind: "removed",
		});
		expect(added).toContainEqual({
			key: "line:1",
			displayValue: "      2 │ \\ Final newline",
			highlighted: true,
			kind: "added",
		});
	});

	it("keeps edit transcript display compact for numbered demo lines", () => {
		const output = renderToString(
			React.createElement(ToolResultView, {
				status: "done",
				title: "Applied 1 replacement",
				detailLines: [
					{
						key: "old",
						displayValue: "   1      -old text",
						highlighted: true,
					},
					{
						key: "new",
						displayValue: "        1 +alpha",
						highlighted: true,
					},
				],
			}),
		);

		expect(output).toContain("   1      -old text");
		expect(output).toContain("        1 +alpha");
		expect(output).not.toContain("-line 1:");
		expect(output).not.toContain("+line 01:");
	});

	it("keeps edit diff highlights wide without reaching the terminal edge", () => {
		expect(diffDetailBlockWidth(140)).toBe(96);
		expect(diffDetailBlockWidth(100)).toBe(86);
		expect(diffDetailBlockWidth(30)).toBe(24);
	});

	it("renders generic tool detail without diff rewriting", () => {
		const output = renderToString(
			React.createElement(ToolResultView, {
				status: "done",
				title: "Reported detail",
				detail: "+ not a diff\n- also plain",
			}),
		);

		expect(output).toContain("+ not a diff");
		expect(output).toContain("- also plain");
	});
});
