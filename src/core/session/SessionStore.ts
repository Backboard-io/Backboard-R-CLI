import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { qSessionDir } from "../../config/paths.ts";
import { ensureDir } from "../../utils/fs.ts";

export interface SessionPaths {
	root: string;
	clientLog: string;
	serverLog: string;
	meta: string;
	/** Checkpoint engine home: journal.jsonl lives directly inside. */
	checkpoints: string;
	/** Content-addressed pre-image blobs (sha256 fanout). */
	checkpointObjects: string;
	/**
	 * Workspace-level pointer (shared across sessions, next to the session
	 * dirs) naming the session whose restore is in flight, so a later process
	 * can finish a restore a crash interrupted.
	 */
	pendingUndo: string;
}

export interface SessionMeta {
	sessionId: string;
	createdAt: string;
	cwd: string;
	model: string;
	profile: string;
}

/** Builds the per-session file layout for a session root directory. */
export function sessionPathsForRoot(root: string): SessionPaths {
	const checkpoints = join(root, "checkpoints");
	return {
		root,
		clientLog: join(root, "client.jsonl"),
		serverLog: join(root, "server.jsonl"),
		meta: join(root, "meta.json"),
		checkpoints,
		// Shared across sessions (sibling of the session dirs, like the
		// pending-undo pointer): blobs are content-addressed and immutable, so
		// sharing turns the per-session workspace copy into a one-time,
		// deduplicated store instead of unbounded growth.
		checkpointObjects: join(dirname(root), "objects"),
		pendingUndo: join(dirname(root), "pending-undo.json"),
	};
}

/**
 * Owns the on-disk layout for a single run. One directory per session under
 * `<cwd>/.backboard/sessions/<sessionId>/`, containing client + server JSONL
 * logs and a meta record. Resume is out of scope for this draft, but the structure is
 * sufficient to reconstruct the entire run later.
 */
export class SessionStore {
	readonly paths: SessionPaths;

	constructor(
		readonly sessionId: string,
		baseDir: string,
	) {
		this.paths = sessionPathsForRoot(qSessionDir(baseDir, sessionId));
	}

	async init(meta: SessionMeta): Promise<void> {
		await ensureDir(this.paths.root);
		await ensureDir(this.paths.checkpoints);
		await ensureDir(this.paths.checkpointObjects);
		await writeFile(this.paths.meta, JSON.stringify(meta, null, 2), "utf8");
	}
}
