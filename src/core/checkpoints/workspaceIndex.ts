import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import { type BlobStore, sha256Hex } from "./blobStore.ts";
import { MAX_CAPTURE_BYTES } from "./CheckpointStore.ts";

/** Workspaces with more files than this are too big to snapshot per command. */
export const MAX_INDEX_FILES = 25_000;
/** Total bytes of captured content above which shell capture shuts off. */
export const MAX_INDEX_BYTES = 500 * 1024 * 1024;
/**
 * Files whose mtime falls within this window before the previous refresh are
 * "racy" (the git racy-index problem): a same-size in-place rewrite landing in
 * the same mtime tick as the cached stat would otherwise be invisible to the
 * (size, mtimeMs) cache. Sized to cover coarse filesystem/kernel timestamp
 * granularity (up to ~10ms on Linux) with margin.
 */
export const RACY_MTIME_WINDOW_MS = 100;

/** Directory names never descended into (VCS internals, deps, build output). */
const DENY_DIRS = new Set([
	".git",
	".backboard",
	"node_modules",
	".venv",
	"venv",
	"__pycache__",
	".cache",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".turbo",
	"coverage",
]);

export interface IndexEntry {
	path: string;
	size: number;
	mtimeMs: number;
	mode: number;
	/** Absent for files over MAX_CAPTURE_BYTES (`tooLarge`). */
	hash?: string;
	/** The content behind `hash` is in the blob store (restorable). */
	stored?: boolean;
	tooLarge?: boolean;
}

export type WorkspaceSnapshot = Map<string, IndexEntry>;

export interface WorkspaceDiffEntry {
	path: string;
	/** State at the `before` snapshot; null when the path did not exist. */
	before: IndexEntry | null;
	/** Content hash after; null when deleted or the after-file is too large. */
	afterHash: string | null;
	afterTooLarge?: boolean;
}

export interface WorkspaceDiff {
	created: WorkspaceDiffEntry[];
	modified: WorkspaceDiffEntry[];
	deleted: WorkspaceDiffEntry[];
}

/**
 * Incremental content index of a workspace tree, used to detect the file
 * side-effects of shell commands (which, unlike Edit/Write, cannot journal
 * their own pre-images). A refresh stats every file under the root and only
 * re-reads/re-hashes files whose (size, mtimeMs) changed — plus "racy" files
 * whose mtime is too close to the previous refresh to be trusted — the blob
 * write for a changed file doubles as its pre-image capture. Symlinks are never
 * followed, deny-listed directories are never entered, and blowing either
 * scale cap permanently disables the index rather than slowing every command.
 */
export class WorkspaceIndex {
	private readonly entries: WorkspaceSnapshot = new Map();
	private disabledReason: string | null = null;
	/** Wall-clock start of the refresh that produced `entries` (racy check). */
	private lastRefreshAt = 0;
	readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	/** Non-null once the index shut itself off; refresh() is then a no-op. */
	get disabled(): string | null {
		return this.disabledReason;
	}

	/**
	 * Re-scans the tree, stores changed content into `blobs`, and returns the
	 * new snapshot (callers diff successive snapshots). Returns null when the
	 * index is (or becomes) disabled.
	 *
	 * `storeBlobs: false` hashes without writing blobs — used by the startup
	 * warm-up so sessions that never run a shell command write nothing to
	 * disk. A later storing refresh upgrades un-stored entries (re-reading
	 * their bytes) before any command relies on them as pre-images.
	 */
	async refresh(
		blobs: BlobStore,
		opts: { storeBlobs?: boolean } = {},
	): Promise<WorkspaceSnapshot | null> {
		const storeBlobs = opts.storeBlobs ?? true;
		if (this.disabledReason) return null;
		const startedAt = Date.now();
		const prevRefreshAt = this.lastRefreshAt;
		const paths: string[] = [];
		try {
			await this.walk(this.root, paths);
		} catch (error) {
			this.disable(`workspace scan failed: ${errorMessage(error)}`);
			return null;
		}
		if (this.disabledReason) return null;

		const next: WorkspaceSnapshot = new Map();
		let capturedBytes = 0;
		for (const path of paths) {
			let stats: Awaited<ReturnType<typeof lstat>>;
			try {
				stats = await lstat(path);
			} catch {
				// Deleted between readdir and stat (build churn): not a file now.
				continue;
			}
			if (!stats.isFile()) continue;
			const key = indexPathKey(path);
			const entry = await this.entryFor(
				path,
				stats,
				blobs,
				storeBlobs,
				prevRefreshAt,
			);
			if (entry === null) continue;
			if (!entry.tooLarge) {
				capturedBytes += entry.size;
				if (capturedBytes > MAX_INDEX_BYTES) {
					this.disable(
						`workspace exceeds the ${MAX_INDEX_BYTES}-byte capture cap`,
					);
					return null;
				}
			}
			next.set(key, entry);
		}
		this.entries.clear();
		for (const [key, entry] of next) this.entries.set(key, entry);
		this.lastRefreshAt = startedAt;
		return next;
	}

	/** Per-path changes between two snapshots returned by `refresh()`. */
	diff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff {
		const created: WorkspaceDiffEntry[] = [];
		const modified: WorkspaceDiffEntry[] = [];
		const deleted: WorkspaceDiffEntry[] = [];
		for (const [key, entry] of after) {
			const prev = before.get(key);
			if (!prev) {
				created.push({
					path: entry.path,
					before: null,
					afterHash: entry.hash ?? null,
					...(entry.tooLarge ? { afterTooLarge: true } : {}),
				});
			} else if (prev.hash !== entry.hash || prev.tooLarge !== entry.tooLarge) {
				modified.push({
					path: entry.path,
					before: prev,
					afterHash: entry.hash ?? null,
					...(entry.tooLarge ? { afterTooLarge: true } : {}),
				});
			}
		}
		for (const [key, prev] of before) {
			if (!after.has(key)) {
				deleted.push({ path: prev.path, before: prev, afterHash: null });
			}
		}
		return { created, modified, deleted };
	}

	private disable(reason: string): void {
		this.disabledReason = reason;
		this.entries.clear();
	}

	private async walk(dir: string, paths: string[]): Promise<void> {
		let dirents: Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory (permissions, raced delete): skip its subtree.
			return;
		}
		for (const dirent of dirents) {
			if (this.disabledReason) return;
			if (dirent.isSymbolicLink()) continue;
			const path = join(dir, dirent.name);
			if (dirent.isDirectory()) {
				if (DENY_DIRS.has(dirent.name)) continue;
				await this.walk(path, paths);
			} else if (dirent.isFile()) {
				paths.push(path);
				if (paths.length > MAX_INDEX_FILES) {
					this.disable(`workspace exceeds the ${MAX_INDEX_FILES}-file cap`);
					return;
				}
			}
			// Sockets/FIFOs/devices: never indexed.
		}
	}

	/**
	 * Reuses the cached hash when (size, mtimeMs) is unchanged — unless this
	 * is a storing refresh and the cached entry's bytes were never written to
	 * the blob store (hash-only warm-up), or the cached mtime is within
	 * RACY_MTIME_WINDOW_MS of the refresh that recorded it (a same-tick,
	 * same-size rewrite would be indistinguishable from the cached state).
	 * In either case the file is re-read.
	 */
	private async entryFor(
		path: string,
		stats: { size: number; mtimeMs: number; mode: number },
		blobs: BlobStore,
		storeBlobs: boolean,
		prevRefreshAt: number,
	): Promise<IndexEntry | null> {
		const base = {
			path,
			size: stats.size,
			mtimeMs: stats.mtimeMs,
			mode: stats.mode & 0o777,
		};
		if (stats.size > MAX_CAPTURE_BYTES) return { ...base, tooLarge: true };
		const cached = this.entries.get(indexPathKey(path));
		if (
			cached &&
			!cached.tooLarge &&
			cached.size === stats.size &&
			cached.mtimeMs === stats.mtimeMs &&
			cached.mtimeMs < prevRefreshAt - RACY_MTIME_WINDOW_MS &&
			cached.hash &&
			(cached.stored || !storeBlobs)
		) {
			return { ...base, hash: cached.hash, stored: cached.stored };
		}
		let content: Uint8Array;
		try {
			content = await readFile(path);
		} catch {
			// Deleted/locked mid-scan: treat as absent this round.
			return null;
		}
		const hash = sha256Hex(content);
		// A racy re-read that confirms unchanged content skips the blob write.
		const alreadyStored = cached?.hash === hash && cached.stored === true;
		if (storeBlobs && !alreadyStored) await blobs.put(content);
		return {
			...base,
			hash,
			...(storeBlobs || alreadyStored ? { stored: true } : {}),
		};
	}
}

/** Same case-normalization as CheckpointStore.pathKey. */
export function indexPathKey(path: string): string {
	const resolved = resolve(path);
	return process.platform === "darwin" || process.platform === "win32"
		? resolved.toLowerCase()
		: resolved;
}
