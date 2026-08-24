import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir } from "../../utils/fs.ts";

/** Screenshots older than this are removed from other sessions' directories. */
export const SCREENSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A single session keeps at most this many bytes of screenshots on disk. */
export const SCREENSHOT_SESSION_MAX_BYTES = 50 * 1024 * 1024;

export class ComputerPaths {
	constructor(
		private readonly sessionId: string,
		private readonly root = join(homedir(), ".backboard", "screenshots"),
	) {}

	get screenshotDir(): string {
		return join(this.root, this.sessionId);
	}

	async nextScreenshotPath(
		extension: "png" | "jpg" = "png",
		now = new Date(),
	): Promise<string> {
		await ensureDir(this.screenshotDir);
		const stamp = now
			.toISOString()
			.replaceAll(":", "")
			.replaceAll(".", "")
			.replace("T", "_")
			.replace("Z", "");
		return join(this.screenshotDir, `screen_${stamp}.${extension}`);
	}

	/**
	 * Keeps the session directory under `maxBytes` by deleting the oldest
	 * screenshots first. Never touches the newest file.
	 */
	async pruneSession(maxBytes = SCREENSHOT_SESSION_MAX_BYTES): Promise<number> {
		let entries: string[];
		try {
			entries = await readdir(this.screenshotDir);
		} catch {
			return 0;
		}
		const files = (
			await Promise.all(
				entries.map(async (name) => {
					const path = join(this.screenshotDir, name);
					try {
						const info = await stat(path);
						return info.isFile()
							? { path, size: info.size, mtime: info.mtimeMs }
							: null;
					} catch {
						return null;
					}
				}),
			)
		).filter((file): file is NonNullable<typeof file> => file !== null);
		files.sort((a, b) => a.mtime - b.mtime);
		let total = files.reduce((sum, file) => sum + file.size, 0);
		let removed = 0;
		for (const file of files) {
			if (total <= maxBytes || files.length - removed <= 1) break;
			await rm(file.path, { force: true });
			total -= file.size;
			removed++;
		}
		return removed;
	}

	/** Deletes other sessions' screenshot directories older than `maxAgeMs`. */
	async pruneOldSessions(
		maxAgeMs = SCREENSHOT_MAX_AGE_MS,
		now = Date.now(),
	): Promise<number> {
		let entries: string[];
		try {
			entries = await readdir(this.root);
		} catch {
			return 0;
		}
		let removed = 0;
		for (const name of entries) {
			if (name === this.sessionId) continue;
			const path = join(this.root, name);
			try {
				const info = await stat(path);
				if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
				await rm(path, { recursive: true, force: true });
				removed++;
			} catch {
				// Best effort: a vanished or unreadable directory is not an error.
			}
		}
		return removed;
	}
}
