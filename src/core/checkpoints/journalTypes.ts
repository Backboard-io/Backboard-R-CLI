/**
 * On-disk journal record shapes for the checkpoint engine. The journal is an
 * append-only JSONL file (`checkpoints/journal.jsonl` in the session dir);
 * every record carries a monotonic `seq` and an ISO `ts` so state can be
 * reconstructed deterministically after a crash or in a later process.
 */

/** Fields common to every journal record. */
export interface JournalRecordBase {
	seq: number;
	ts: string;
}

/**
 * Marks the start of a checkpoint group. `kind: "turn"` records come from
 * `turn:start` bus events (label = leading chars of the user message);
 * `kind: "redo-point"` records are synthesized by `restore()` to capture the
 * pre-restore disk state so `/redo` can reapply it.
 */
export interface TurnJournalRecord extends JournalRecordBase {
	type: "turn";
	turnId: string;
	label: string;
	kind?: "turn" | "redo-point";
}

/**
 * Byte-exact pre-image of a path, captured before a tool mutates the disk.
 * `hash` names a blob in the content-addressed store; absent when the file
 * did not exist (`existed: false`) or is not a regular file
 * (`unsupported: true` — symlinks etc. are never captured or clobbered).
 */
export interface PreImageJournalRecord extends JournalRecordBase {
	type: "pre";
	turnId: string;
	toolCallId: string;
	tool: string;
	path: string;
	existed: boolean;
	hash?: string;
	size?: number;
	mode?: number;
	unsupported?: boolean;
	/** Directories the tool is about to create; pruned (if empty) on undo. */
	createdDirs?: string[];
}

/**
 * Hash of what the tool left on disk. `postHash: null` means the path is
 * absent after the operation (e.g. an ApplyPatch delete). Divergence checks
 * compare the current disk hash against the newest post record per path.
 */
export interface PostImageJournalRecord extends JournalRecordBase {
	type: "post";
	turnId: string;
	toolCallId: string;
	path: string;
	postHash: string | null;
}

/** A capture that was intentionally not taken (e.g. file over the size cap). */
export interface SkipJournalRecord extends JournalRecordBase {
	type: "skip";
	turnId: string;
	toolCallId: string;
	path: string;
	reason: "too_large";
	size?: number;
}

/**
 * Neutralizes an earlier `pre`/`skip` record. Written when a capture's run
 * lost checkpoint access (moved to the background) after its own record was
 * already durable: the matching post-image will never be journaled, so the
 * orphaned pre-image must not stay in the turn's checkpoint or `/undo` would
 * revert a write the background run went on to complete.
 */
export interface RevokeJournalRecord extends JournalRecordBase {
	type: "revoke";
	turnId: string;
	/** `seq` of the record this one drops. */
	ref: number;
	path: string;
}

/** Closes a checkpoint group; only finalized, non-empty groups are listed. */
export interface FinalizeJournalRecord extends JournalRecordBase {
	type: "finalize";
	turnId: string;
	status: "ok" | "cancelled" | "empty";
}

/**
 * Write-ahead marker for a restore. Persisted (and flushed) BEFORE any disk
 * mutation; carries the full resolved plan so `recoverIfNeeded()` can re-run
 * an interrupted restore without re-planning.
 */
export interface UndoStartJournalRecord extends JournalRecordBase {
	type: "undo:start";
	undoId: string;
	targetCheckpointId: string;
	redoCheckpointId: string | null;
	/** Divergence policy the user chose, re-applied on crash replay. */
	skipDiverged?: boolean;
	files: RestorePlanEntry[];
}

/** Progress marker: `path` has been fully restored (idempotent to replay). */
export interface UndoFileJournalRecord extends JournalRecordBase {
	type: "undo:file";
	undoId: string;
	path: string;
}

/** Restore completed; clears the write-ahead marker. */
export interface UndoDoneJournalRecord extends JournalRecordBase {
	type: "undo:done";
	undoId: string;
	redoCheckpointId: string | null;
}

export type JournalRecord =
	| TurnJournalRecord
	| PreImageJournalRecord
	| PostImageJournalRecord
	| SkipJournalRecord
	| RevokeJournalRecord
	| FinalizeJournalRecord
	| UndoStartJournalRecord
	| UndoFileJournalRecord
	| UndoDoneJournalRecord;

/** One checkpoint a user can restore to, as shown by `/rewind`. */
export interface CheckpointSummary {
	id: string;
	kind: "turn" | "redo-point";
	label: string;
	ts: string;
	/** Unique absolute paths touched during the checkpoint's turn. */
	files: string[];
	/** Paths the turn created (absent before, present after). */
	added: string[];
	/** Paths the turn deleted (present before, absent after). */
	removed: string[];
	/** Paths the turn changed in place. */
	modified: string[];
	/** Paths recorded but not revertible (too large / unsupported). */
	skippedFiles: string[];
}

export type RestoreAction =
	| "write"
	| "delete"
	| "skip-unsupported"
	| "skip-too-large";

/** Resolved per-path step of a restore, computed by `planRestore()`. */
export interface RestorePlanEntry {
	path: string;
	action: RestoreAction;
	/** Current disk content differs from the newest recorded post-image. */
	diverged: boolean;
	/** Blob to write for `action: "write"`. */
	hash?: string;
	mode?: number;
	/** Dirs (deepest last) created alongside the file; pruned if empty. */
	createdDirs?: string[];
}

export interface RestorePlan {
	checkpointId: string;
	entries: RestorePlanEntry[];
}

export interface RestoreResult {
	checkpointId: string;
	/** Paths whose recorded pre-image content was written back. */
	restored: string[];
	/** Paths deleted because they did not exist at the checkpoint. */
	deleted: string[];
	skipped: Array<{ path: string; reason: string }>;
	/** Synthetic checkpoint capturing pre-restore state, for `/redo`. */
	redoCheckpointId: string | null;
}
