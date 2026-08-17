import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAttachments } from "../src/providers/byok/attachments.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "byok-attach-"));
	try {
		await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("loadAttachments", () => {
	it("inlines image files as base64", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "pic.png");
			const raw = Buffer.from("hello", "utf8");
			await writeFile(path, raw);
			const attachments = await loadAttachments([path]);
			expect(attachments).toHaveLength(1);
			expect(attachments[0]?.path).toBe("pic.png");
			expect(attachments[0]?.mediaType).toBe("image/png");
			expect(attachments[0]?.base64).toBe(raw.toString("base64"));
			expect(attachments[0]?.text).toBeUndefined();
		});
	});

	it("inlines text files as text with a basename", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "notes.txt");
			await writeFile(path, "line one\nline two");
			const attachments = await loadAttachments([path]);
			expect(attachments).toHaveLength(1);
			expect(attachments[0]?.path).toBe("notes.txt");
			expect(attachments[0]?.mediaType).toBe("text/plain");
			expect(attachments[0]?.text).toBe("line one\nline two");
			expect(attachments[0]?.base64).toBeUndefined();
		});
	});

	it("truncates text that exceeds the inline limit", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "big.txt");
			await writeFile(path, "x".repeat(70 * 1024));
			const attachments = await loadAttachments([path]);
			expect(attachments[0]?.text).toContain("truncated");
			expect((attachments[0]?.text ?? "").length).toBeLessThan(70 * 1024);
		});
	});

	it("skips unreadable files without throwing", async () => {
		await withTempDir(async (dir) => {
			const attachments = await loadAttachments([
				join(dir, "does-not-exist.txt"),
			]);
			expect(attachments).toEqual([]);
		});
	});

	it("returns an empty list for no inputs", async () => {
		expect(await loadAttachments([])).toEqual([]);
	});
});
