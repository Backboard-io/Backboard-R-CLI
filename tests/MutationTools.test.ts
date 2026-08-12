import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { ApplyPatchTool } from "../src/tools/ApplyPatchTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";

function context(cwd: string): ToolContext {
	return {
		sessionId: "sess_test",
		cwd,
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "noop",
		agentDepth: 0,
	};
}

async function tempDir(): Promise<string> {
	return await mkdtemp(join(tmpdir(), "cli-tools-"));
}

describe("mutation tools", () => {
	it("writes full file contents", async () => {
		const cwd = await tempDir();
		const tool = new WriteTool();

		await tool.execute(
			{ file_path: "nested/file.txt", content: "hello\nworld\n" },
			context(cwd),
		);

		expect(await readFile(join(cwd, "nested/file.txt"), "utf8")).toBe(
			"hello\nworld\n",
		);
	});

	it("applies multiple multiline edits and legacy single edits", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\nthree\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [
					{ old_str: "one\ntwo", new_str: "1\n2" },
					{ old_str: "three", new_str: "3" },
				],
			},
			context(cwd),
		);
		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				old_str: "1",
				new_str: "one",
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\n2\n3\n");
	});

	it("normalizes edits sent as a JSON string array", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: JSON.stringify([
					{ old_str: "one", new_str: "1" },
					{ old_str: "two", new_str: "2" },
				]),
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("1\n2\n");
	});

	it("normalizes edits sent as a single object", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: { old_str: "one", new_str: "1" },
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("1\ntwo\n");
	});

	it("normalizes edits sent as a JSON string of a single object", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "one\ntwo\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			tool.parseInput({
				file_path: "file.txt",
				edits: JSON.stringify({ old_str: "two", new_str: "2" }),
			}),
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("one\n2\n");
	});

	it("treats $ sequences in new_str literally", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "price = X\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "X", new_str: "$${amount} and $1" }],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"price = $${amount} and $1\n",
		);
	});

	it("matches multiline edits in CRLF files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\r\nbeta\r\n", "utf8");
		const tool = new EditTool();

		await tool.execute(
			{
				file_path: "file.txt",
				edits: [{ old_str: "alpha\nbeta", new_str: "one\ntwo" }],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"one\r\ntwo\r\n",
		);
	});

	it("does not partially write when a later edit fails", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\nbeta\n", "utf8");
		const tool = new EditTool();

		await expect(
			tool.execute(
				{
					file_path: "file.txt",
					edits: [
						{ old_str: "alpha", new_str: "one" },
						{ old_str: "missing", new_str: "two" },
					],
				},
				context(cwd),
			),
		).rejects.toThrow("old_str not found");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\nbeta\n");
	});

	it("matches every old_str against the original snapshot, not earlier edits", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "file.txt"),
			"const a = 1;\nconst b = a;\n",
			"utf8",
		);
		const tool = new EditTool();

		// Under sequential semantics the first edit would rewrite the text the
		// second edit needs to match; under snapshot semantics both match.
		await tool.execute(
			{
				file_path: "file.txt",
				edits: [
					{ old_str: "const a = 1;", new_str: "const alpha = 1;" },
					{ old_str: "const b = a;", new_str: "const b = alpha;" },
				],
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"const alpha = 1;\nconst b = alpha;\n",
		);
	});

	it("rejects edits that overlap the same text", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha beta gamma\n", "utf8");
		const tool = new EditTool();

		await expect(
			tool.execute(
				{
					file_path: "file.txt",
					edits: [
						{ old_str: "alpha beta", new_str: "one" },
						{ old_str: "beta gamma", new_str: "two" },
					],
				},
				context(cwd),
			),
		).rejects.toThrow("overlap");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"alpha beta gamma\n",
		);
	});

	it("serializes parallel edits to the same file", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "a\n", "utf8");
		const scheduler = new ToolScheduler(
			new ToolRegistry([new EditTool()]),
			new EventBus(),
		);

		const outputs = await scheduler.run(
			[
				{
					id: "call_1",
					name: "Edit",
					input: {
						file_path: "file.txt",
						edits: [{ old_str: "a", new_str: "b" }],
					},
				},
				{
					id: "call_2",
					name: "Edit",
					input: {
						file_path: "file.txt",
						edits: [{ old_str: "b", new_str: "c" }],
					},
				},
			],
			context(cwd),
		);

		expect(outputs.every((output) => !output.metadata?.error)).toBe(true);
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("c\n");
	});

	it("applies large patches and appends add-only updates to empty files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "empty.txt"), "", "utf8");
		await writeFile(join(cwd, "large.txt"), "line 1\nline 2\nline 3\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: empty.txt",
					"@@",
					"+first",
					"+second",
					"*** Update File: large.txt",
					"@@",
					" line 1",
					"-line 2",
					"+line two",
					" line 3",
					"*** Add File: added.txt",
					"+created",
					"+file",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "empty.txt"), "utf8")).toBe(
			"first\nsecond\n",
		);
		expect(await readFile(join(cwd, "large.txt"), "utf8")).toBe(
			"line 1\nline two\nline 3\n",
		);
		expect(await readFile(join(cwd, "added.txt"), "utf8")).toBe(
			"created\nfile\n",
		);
	});

	it("returns compact diff detail lines for applied patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\nbeta\n", "utf8");
		const tool = new ApplyPatchTool();

		const result = await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					" alpha",
					"-beta",
					"+gamma",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(result.title).toBe("Changed +1, -1 lines");
		expect(result.detail).toBeUndefined();
		expect(result.detailLines).toContainEqual({
			key: "file.txt:line:1",
			displayValue: "  2     │ beta",
			highlighted: true,
			kind: "removed",
		});
		expect(result.detailLines).toContainEqual({
			key: "file.txt:line:2",
			displayValue: "      2 │ gamma",
			highlighted: true,
			kind: "added",
		});
	});

	it("does not partially write invalid patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\n", "utf8");
		const tool = new ApplyPatchTool();

		await expect(
			tool.execute(
				{
					patch: [
						"*** Begin Patch",
						"*** Add File: created.txt",
						"+created",
						"*** Update File: file.txt",
						"@@",
						" missing",
						"-alpha",
						"+beta",
						"*** End Patch",
					].join("\n"),
				},
				context(cwd),
			),
		).rejects.toThrow("Failed to find expected lines in file.txt");
		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe("alpha\n");
		await expect(readFile(join(cwd, "created.txt"), "utf8")).rejects.toThrow();
	});

	it("deletes files from patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Delete File: file.txt",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		await expect(readFile(join(cwd, "file.txt"), "utf8")).rejects.toThrow();
	});

	it("moves files while applying patches", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "old.txt"), "alpha\nbeta\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: old.txt",
					"*** Move to: new.txt",
					"@@",
					" alpha",
					"-beta",
					"+gamma",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		await expect(readFile(join(cwd, "old.txt"), "utf8")).rejects.toThrow();
		expect(await readFile(join(cwd, "new.txt"), "utf8")).toBe("alpha\ngamma\n");
	});

	it("uses hunk context anchors to target later matches", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "file.txt"),
			"first\nvalue\nsecond\nvalue\n",
			"utf8",
		);
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@ second",
					"-value",
					"+changed",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"first\nvalue\nsecond\nchanged\n",
		);
	});

	it("matches patch context with whitespace and unicode punctuation drift", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "alpha   \nquote “value”\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					" alpha",
					'-quote "value"',
					"+quote changed",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"alpha\nquote changed\n",
		);
	});

	it("anchors patch hunks at the end of files", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "file.txt"), "tail\nmiddle\ntail\n", "utf8");
		const tool = new ApplyPatchTool();

		await tool.execute(
			{
				patch: [
					"*** Begin Patch",
					"*** Update File: file.txt",
					"@@",
					"-tail",
					"+end",
					"*** End of File",
					"*** End Patch",
				].join("\n"),
			},
			context(cwd),
		);

		expect(await readFile(join(cwd, "file.txt"), "utf8")).toBe(
			"tail\nmiddle\nend\n",
		);
	});
});
