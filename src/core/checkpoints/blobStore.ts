import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, fileExists, renameOver } from "../../utils/fs.ts";
import { shortId } from "../../utils/id.ts";

export function sha256Hex(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Content-addressed blob store for checkpoint pre-images. Blobs are raw bytes
 * named by their sha256 hex digest under a 2-char fanout directory
 * (`objects/ab/abcdef…`), written via temp-file + rename for atomicity.
 * Blobs are immutable: a blob that already exists is never rewritten, which
 * makes `put` a cheap dedupe for repeated captures of identical content.
 */
export class BlobStore {
	constructor(readonly root: string) {}

	pathFor(hash: string): string {
		return join(this.root, hash.slice(0, 2), hash);
	}

	async has(hash: string): Promise<boolean> {
		return fileExists(this.pathFor(hash));
	}

	/** Stores `content` and returns its sha256 hex digest. */
	async put(content: Uint8Array): Promise<string> {
		const hash = sha256Hex(content);
		const dest = this.pathFor(hash);
		if (await fileExists(dest)) return hash;
		const dir = dirname(dest);
		await ensureDir(dir, 0o700);
		const temp = join(dir, `.${shortId("tmp")}`);
		await writeFile(temp, content, { mode: 0o600 });
		try {
			// renameOver retries EBUSY and falls back on EEXIST/EPERM (Windows AV
			// scanners briefly lock fresh files); capture must not fail spuriously.
			await renameOver(temp, dest);
		} catch (error) {
			// A concurrent put of the same content may have won the rename race;
			// the blob is immutable, so an existing destination is success.
			await rm(temp, { force: true });
			if (!(await fileExists(dest))) throw error;
		}
		return hash;
	}

	/** Returns the raw bytes of a blob; throws if the blob is missing. */
	async get(hash: string): Promise<Buffer> {
		return readFile(this.pathFor(hash));
	}
}
