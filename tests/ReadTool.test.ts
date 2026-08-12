import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { READ_TOOL_MAX_BYTES } from "../src/tools/ReadTool.constants.ts";
import { ReadTool } from "../src/tools/ReadTool.tsx";

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
	return await mkdtemp(join(tmpdir(), "cli-read-"));
}

describe("ReadTool", () => {
	it("reads text files as plain text", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "notes.txt"), "alpha\nbeta\n", "utf8");

		const result = await new ReadTool().execute(
			{ file_path: "notes.txt" },
			context(cwd),
		);

		expect(result.forLLM).toBe("alpha\nbeta\n");
		expect(result.title).toBe("Read 3 lines");
	});

	it("returns supported image files as direct image payloads", async () => {
		const fixturePath = join(import.meta.dir, "fixtures", "read-image.png");
		const imageBytes = await readFile(fixturePath);

		const result = await new ReadTool().execute(
			{ file_path: fixturePath },
			context(await tempDir()),
		);
		const payload = JSON.parse(result.forLLM) as Record<string, unknown>;

		expect(payload.contentType).toBe("image");
		expect(payload.mimeType).toBe("image/png");
		expect(payload.__image_media_type).toBe("image/png");
		expect(payload.__image_base64).toBe(imageBytes.toString("base64"));
		expect(result.title).toContain("Read image");
	});

	it("maps additional supported image extensions to MIME types", async () => {
		const cwd = await tempDir();
		await writeFile(join(cwd, "sample.webp"), Buffer.from("image-bytes"));

		const result = await new ReadTool().execute(
			{ file_path: "sample.webp" },
			context(cwd),
		);
		const payload = JSON.parse(result.forLLM) as Record<string, unknown>;

		expect(payload.mimeType).toBe("image/webp");
		expect(payload.__image_media_type).toBe("image/webp");
	});

	it("rejects oversized image files before encoding", async () => {
		const cwd = await tempDir();
		await writeFile(
			join(cwd, "huge.png"),
			Buffer.alloc(READ_TOOL_MAX_BYTES + 1),
		);

		await expect(
			new ReadTool().execute({ file_path: "huge.png" }, context(cwd)),
		).rejects.toThrow("File too large");
	});
});
