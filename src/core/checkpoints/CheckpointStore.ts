import { readFileSync } from "node:fs";
import { chmod, lstat, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { errorMessage } from "../../utils/errors.ts";
import {
	ensureDir,
	isErrnoException,
	renameOver,
	unlinkTolerant,
} from "../../utils/fs.ts";
import { shortId } from "../../utils/id.ts";
import { withPathLocks } from "../../utils/pathLocks.ts";
import { isProcessAlive } from "../../utils/process.ts";
import { EventBus } from "../bus/EventBus.ts";
import { JsonlWriter } from "../session/JsonlWriter.ts";
import {
	type SessionPaths,
	sessionPathsForRoot,
} from "../session/SessionStore.ts";
import { BlobStore, sha256Hex } from "./blobStore.ts";
import type {
	CheckpointSummary,
	JournalRecord,
	PostImageJournalRecord,
	PreImageJournalRecord,
	RestorePlan,
	RestorePlanEntry,
	RestoreResult,
	SkipJournalRecord,
	TurnJournalRecord,
	UndoDoneJournalRecord,
	UndoFileJournalRecord,
	UndoStartJournalRecord,
} from "./journalTypes.ts";
import { WorkspaceIndex, type WorkspaceSnapshot } from "./workspaceIndex.ts";

/** Pre-images above this size are not captured (journaled as skips). */
export const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

const TURN_LABEL_MAX = 60;
const REDO_TOOL = "redo-point";
/** A begin walk is skipped when a storing refresh completed this recently. */
const BEGIN_SKIP_FRESH_MS = 2_000;

/** The slice of ToolContext the checkpoint engine needs at capture time. */
export interface CheckpointCallContext {
	turnId?: string;
	toolCallId?: string;
}

export interface RecordPreImageOptions {
	createdDirs?: string[];
	tool?: string;
	/**
	 * Throw instead of journaling a skip when the pre-image cannot be captured
	 * (file over the size cap) — for tools that promise atomic rollback and
	 * must refuse a write they could not revert.
	 */
	requireRevertible?: boolean;
}

/**
 * The capture surface tools see as `ToolContext.checkpoints`. The full
 * `CheckpointStore` implements it; `scopedToTurn` produces a view that
 * re-attributes captures so sub-agent edits fold into the spawning user
 * turn's checkpoint.
 */
export interface CheckpointRecorder {
	recordPreImage(
		absPath: string,
		ctx: CheckpointCallContext,
		opts?: RecordPreImageOptions,
	): Promise<void>;
	recordPostImage(
		absPath: string,
		ctx: CheckpointCallContext,
		contentIfInMemory?: Uint8Array,
	): Promise<void>;
	revertToolCall(toolCallId: string): Promise<void>;
	/** Snapshots the workspace before a shell command (never throws). */
	beginShellCapture(cwd: string, ctx: CheckpointCallContext): Promise<void>;
	/** Diffs against the begin snapshot and journals shell side-effects. */
	endShellCapture(ctx: CheckpointCallContext): Promise<void>;
	/** One-shot warning when shell capture disabled itself, else null. */
	captureWarning(): string | null;
	scopedToTurn(turnId: string): CheckpointRecorder;
}

export interface RevocableRecorder {
	recorder: CheckpointRecorder;
	revoke: () => void;
}

/**
 * Wraps a recorder so journaling can be switched off after contexts holding it
 * have already been copied. Used when a run outlives the turn it was scoped to.
 */
export function revocableRecorder(
	recorder: CheckpointRecorder,
): RevocableRecorder {
	let live = true;
	const noop = async (): Promise<void> => {};
	return {
		revoke: () => {
			live = false;
		},
		recorder: {
			recordPreImage: (...args) =>
				live ? recorder.recordPreImage(...args) : noop(),
			recordPostImage: (...args) =>
				live ? recorder.recordPostImage(...args) : noop(),
			revertToolCall: (...args) =>
				live ? recorder.revertToolCall(...args) : noop(),
			beginShellCapture: (...args) =>
				live ? recorder.beginShellCapture(...args) : noop(),
			endShellCapture: (...args) =>
				live ? recorder.endShellCapture(...args) : noop(),
			captureWarning: () => (live ? recorder.captureWarning() : null),
			scopedToTurn: (turnId) => recorder.scopedToTurn(turnId),
		},
	};
}

export function scopeCheckpointRecorder(
	recorder: CheckpointRecorder,
	turnId: string,
): CheckpointRecorder {
	const scoped: CheckpointRecorder = {
		recordPreImage: (absPath, ctx, opts) =>
			recorder.recordPreImage(absPath, { ...ctx, turnId }, opts),
		recordPostImage: (absPath, ctx, contentIfInMemory) =>
			recorder.recordPostImage(absPath, { ...ctx, turnId }, contentIfInMemory),
		revertToolCall: (toolCallId) => recorder.revertToolCall(toolCallId),
		beginShellCapture: (cwd, ctx) =>
			recorder.beginShellCapture(cwd, { ...ctx, turnId }),
		endShellCapture: (ctx) => recorder.endShellCapture({ ...ctx, turnId }),
		captureWarning: () => recorder.captureWarning(),
		scopedToTurn: () => scoped,
	};
	return scoped;
}

/** Shape of the workspace-level `pending-undo.json` pointer file. */
interface PendingUndoPointer {
	sessionRoot?: string;
	undoId?: string;
	pid?: number;
}

interface DiskState {
	kind: "absent" | "file" | "other";
	hash?: string;
	mode?: number;
}

/**
 * Write-ahead pre-image journal + content-addressed blob store powering
 * /undo, /redo and /rewind. Tools call `recordPreImage` (inside their
 * `withPathLocks` scope, BEFORE the disk write) and `recordPostImage` after;
 * checkpoints group entries by turn via bus `turn:start`/`turn:end`/
 * `turn:cancelled` events. Restore is surgical (only agent-touched paths),
 * divergence-checked per file, and crash-safe: an `undo:start` marker is
 * flushed before any disk mutation (with a workspace-level pointer file so a
 * fresh process can find the crashed session's journal) and
 * `recoverIfNeeded()` / `recoverAbandonedRestore()` idempotently replay an
 * interrupted restore. Pre-images are raw bytes, so CRLF/BOM/binary content
 * round-trips exactly. Requires no git anywhere.
 *
 * Durability boundary: "flushed" means the async appendFile completed — it
 * guards against the CLI process dying, not against power loss (no fsync).
 */
export class CheckpointStore implements CheckpointRecorder {
	private readonly records: JournalRecord[] = [];
	private readonly journal: JsonlWriter;
	private readonly blobs: BlobStore;
	private seq = 0;
	private pendingLabel = "";
	/** turnId -> its (first) turn record; kept in step with `records`. */
	private readonly turnIndex = new Map<string, TurnJournalRecord>();
	/** turnIds with a finalize record; kept in step with `records`. */
	private readonly finalizedTurns = new Set<string>();
	/** turnIds that captured at least one pre/skip entry. */
	private readonly turnsWithEntries = new Set<string>();
	/** pathKey -> newest post record; kept in step with `records`. */
	private readonly latestPostByPath = new Map<string, PostImageJournalRecord>();
	private shellIndex: WorkspaceIndex | null = null;
	/**
	 * Per-tool-call begin snapshots. Concurrent shell commands (parallel tool
	 * calls or sub-agents) each keep their own baseline; note the refreshes
	 * are still serialized, so a command that finishes while another runs can
	 * see (and attribute) the other's in-flight writes — capture stays
	 * best-effort under true concurrency.
	 */
	private readonly shellBegins = new Map<string, WorkspaceSnapshot>();
	/** Snapshot + time of the last blob-storing refresh (begin-skip window). */
	private shellLastStored: {
		snapshot: WorkspaceSnapshot;
		at: number;
	} | null = null;
	/** Serializes workspace refreshes (a warm-up must not race a command). */
	private shellQueue: Promise<void> = Promise.resolve();
	private shellWarning: string | null = null;
	private shellWarningIssued = false;
	private readonly detachBus: Array<() => void> = [];

	constructor(
		readonly paths: SessionPaths,
		private readonly bus: EventBus,
	) {
		this.journal = new JsonlWriter(join(paths.checkpoints, "journal.jsonl"));
		this.blobs = new BlobStore(paths.checkpointObjects);
		this.loadExistingJournal();
		this.detachBus.push(
			bus.on("user:message", (event) => {
				this.pendingLabel = event.text
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, TURN_LABEL_MAX);
			}),
		);
		// No turn record on turn:start: it fires BEFORE user:message, so the
		// label would be the previous prompt. recordPreImage creates the turn
		// lazily at first capture, by which point pendingLabel is current.
		this.detachBus.push(
			bus.on("turn:end", (event) => {
				this.finalizeTurn(event.turnId, "ok");
			}),
			bus.on("turn:cancelled", (event) => {
				this.finalizeTurn(event.turnId, "cancelled");
			}),
		);
	}

	/** Awaits durability of every journal record enqueued so far. */
	async flush(): Promise<void> {
		await this.journal.flush();
	}

	dispose(): void {
		for (const detach of this.detachBus.splice(0)) detach();
	}

	// ---------------------------------------------------------------- capture

	/**
	 * Captures a byte-exact pre-image of `absPath`. MUST be awaited inside the
	 * tool's `withPathLocks` scope, BEFORE the disk write. Throws on capture
	 * failure (ENOSPC/EACCES): a write that cannot be undone must not happen.
	 * Every call journals an entry (needed by `revertToolCall`); checkpoint
	 * composition uses the first pre-image per (turn, path).
	 */
	async recordPreImage(
		absPath: string,
		ctx: CheckpointCallContext,
		opts?: RecordPreImageOptions,
	): Promise<void> {
		const path = resolve(absPath);
		const turnId = ctx.turnId ?? "detached";
		const toolCallId = ctx.toolCallId ?? "unknown";
		const tool = opts?.tool ?? "unknown";
		this.ensureTurn(turnId);

		const stats = await lstatOrNull(path);
		if (!stats) {
			this.append({
				type: "pre",
				turnId,
				toolCallId,
				tool,
				path,
				existed: false,
				...(opts?.createdDirs?.length
					? { createdDirs: opts.createdDirs.map((dir) => resolve(dir)) }
					: {}),
			});
		} else if (!stats.isFile()) {
			this.append({
				type: "pre",
				turnId,
				toolCallId,
				tool,
				path,
				existed: true,
				unsupported: true,
			});
		} else if (stats.size > MAX_CAPTURE_BYTES) {
			if (opts?.requireRevertible) {
				throw new Error(
					`Pre-image of ${path} is not capturable (${stats.size} bytes ` +
						`exceeds the ${MAX_CAPTURE_BYTES}-byte cap), so the write could ` +
						"not be rolled back; aborting before any modification",
				);
			}
			this.append({
				type: "skip",
				turnId,
				toolCallId,
				path,
				reason: "too_large",
				size: stats.size,
			});
		} else {
			const content = await readFile(path);
			const hash = await this.blobs.put(content);
			this.append({
				type: "pre",
				turnId,
				toolCallId,
				tool,
				path,
				existed: true,
				hash,
				size: stats.size,
				mode: stats.mode & 0o777,
			});
		}
		// Write-ahead durability: the journal entry (and blob) must be on disk
		// before the tool mutates the file. Flush errors abort the tool call.
		await this.journal.flush();
	}

	/**
	 * Records the hash of what the tool left on disk (`null` = path absent,
	 * e.g. after an ApplyPatch delete). Pass the written bytes when they are
	 * already in memory to avoid a re-read.
	 */
	async recordPostImage(
		absPath: string,
		ctx: CheckpointCallContext,
		contentIfInMemory?: Uint8Array,
	): Promise<void> {
		const path = resolve(absPath);
		const turnId = ctx.turnId ?? "detached";
		this.ensureTurn(turnId);

		let postHash: string | null;
		if (contentIfInMemory) {
			postHash = sha256Hex(contentIfInMemory);
		} else {
			const stats = await lstatOrNull(path);
			postHash = stats?.isFile() ? sha256Hex(await readFile(path)) : null;
		}
		this.append({
			type: "post",
			turnId,
			toolCallId: ctx.toolCallId ?? "unknown",
			path,
			postHash,
		});
		await this.journal.flush();
	}

	/**
	 * Rolls back every path a single tool call pre-imaged (first pre-image per
	 * path wins). Used by ApplyPatch to make a partially-failed patch atomic.
	 * The caller already holds the path locks, so none are taken here.
	 */
	async revertToolCall(toolCallId: string): Promise<void> {
		const byPath = new Map<string, PreImageJournalRecord>();
		for (const record of this.records) {
			if (record.type !== "pre" || record.toolCallId !== toolCallId) continue;
			const key = this.pathKey(record.path);
			if (!byPath.has(key)) byPath.set(key, record);
		}
		for (const pre of byPath.values()) {
			if (pre.unsupported) continue;
			const postHash = await this.applyPreImage(pre);
			this.append({
				type: "post",
				turnId: pre.turnId,
				toolCallId,
				path: pre.path,
				postHash,
			});
		}
		await this.journal.flush();
	}

	/**
	 * Snapshots the workspace so `endShellCapture` can journal the file
	 * side-effects of a shell command (shell commands cannot record their own
	 * pre-images the way Edit/Write do). The index is rooted at the first cwd
	 * ever passed — the session cwd — and reused for sub-cwd commands; a cwd
	 * outside the root just re-refreshes the same index. Best-effort: any
	 * failure disables capture with a warning instead of failing the tool.
	 */
	async beginShellCapture(
		cwd: string,
		ctx: CheckpointCallContext,
	): Promise<void> {
		const callKey = ctx.toolCallId ?? "unknown";
		await this.enqueueShellOp(async () => {
			try {
				this.shellIndex ??= new WorkspaceIndex(cwd);
				// Back-to-back commands: if a storing refresh just completed (the
				// previous command's end walk), reuse its snapshot instead of
				// re-walking the tree. Hand edits inside this small window are
				// attributed to the command — an accepted trade for not paying two
				// full stat-walks on every `ls`.
				const fresh = this.shellLastStored;
				if (fresh && performance.now() - fresh.at < BEGIN_SKIP_FRESH_MS) {
					this.shellBegins.set(callKey, fresh.snapshot);
					return;
				}
				const snapshot = await this.shellIndex.refresh(this.blobs, {
					storeBlobs: true,
				});
				if (snapshot === null) {
					this.noteShellDisabled();
					return;
				}
				this.shellLastStored = { snapshot, at: performance.now() };
				this.shellBegins.set(callKey, snapshot);
			} catch (error) {
				this.setShellWarning(
					`shell change tracking disabled: ${errorMessage(error)}`,
				);
			}
		});
	}

	/**
	 * Pre-hashes the workspace in the background so the first shell command
	 * does not pay the full initial scan (seconds on very large trees).
	 * Hash-only (no blobs written): a session that never runs a shell command
	 * leaves no trace on disk; the first real begin upgrades the entries it
	 * needs. Fire-and-forget; the queue keeps it from racing a real command.
	 */
	warmShellCapture(cwd: string): void {
		void this.enqueueShellOp(async () => {
			try {
				this.shellIndex ??= new WorkspaceIndex(cwd);
				const snapshot = await this.shellIndex.refresh(this.blobs, {
					storeBlobs: false,
				});
				if (snapshot === null) this.noteShellDisabled();
			} catch {
				// Warm-up is purely opportunistic; a real begin reports failures.
			}
		});
	}

	private enqueueShellOp(op: () => Promise<void>): Promise<void> {
		const next = this.shellQueue.then(op);
		// The queue must survive a rejected op (ops also self-catch).
		this.shellQueue = next.catch(() => {});
		return next;
	}

	/**
	 * Re-scans the workspace, diffs against the begin snapshot and journals a
	 * pre + post pair per changed path, attributed to the shell tool call.
	 * The pre-image blob was already stored by the begin refresh. The after
	 * snapshot becomes the new baseline so back-to-back commands never
	 * double-report the same change. Best-effort like `beginShellCapture`.
	 */
	async endShellCapture(ctx: CheckpointCallContext): Promise<void> {
		await this.enqueueShellOp(() => this.endShellCaptureLocked(ctx));
	}

	private async endShellCaptureLocked(
		ctx: CheckpointCallContext,
	): Promise<void> {
		if (!this.shellIndex) return;
		const callKey = ctx.toolCallId ?? "unknown";
		const before = this.shellBegins.get(callKey);
		this.shellBegins.delete(callKey);
		if (!before) return;
		try {
			const after = await this.shellIndex.refresh(this.blobs, {
				storeBlobs: true,
			});
			if (after === null) {
				this.noteShellDisabled();
				return;
			}
			this.shellLastStored = { snapshot: after, at: performance.now() };
			const diff = this.shellIndex.diff(before, after);
			const changes = [...diff.created, ...diff.modified, ...diff.deleted];
			if (changes.length === 0) return;

			const turnId = ctx.turnId ?? "detached";
			const toolCallId = ctx.toolCallId ?? "unknown";
			const sessionPrefix = `${this.pathKey(this.paths.root)}${sep}`;
			let journaled = false;
			for (const change of changes) {
				if (this.pathKey(change.path).startsWith(sessionPrefix)) continue;
				if (!journaled) this.ensureTurn(turnId);
				journaled = true;
				if (change.before?.tooLarge) {
					this.append({
						type: "skip",
						turnId,
						toolCallId,
						path: change.path,
						reason: "too_large",
						size: change.before.size,
					});
					continue;
				}
				this.append({
					type: "pre",
					turnId,
					toolCallId,
					tool: "execute",
					path: change.path,
					existed: change.before !== null,
					...(change.before?.hash ? { hash: change.before.hash } : {}),
					...(change.before ? { size: change.before.size } : {}),
					...(change.before ? { mode: change.before.mode } : {}),
				});
				// A file that grew past the capture cap has no after-hash; leave
				// the post record out rather than journal a wrong one.
				if (change.afterTooLarge) continue;
				this.append({
					type: "post",
					turnId,
					toolCallId,
					path: change.path,
					postHash: change.afterHash,
				});
			}
			if (journaled) await this.journal.flush();
		} catch (error) {
			this.setShellWarning(
				`shell change tracking disabled: ${errorMessage(error)}`,
			);
		}
	}

	/** Returns (and consumes) the shell-capture warning, once per session. */
	captureWarning(): string | null {
		const warning = this.shellWarning;
		this.shellWarning = null;
		if (warning) this.shellWarningIssued = true;
		return warning;
	}

	private noteShellDisabled(): void {
		const reason = this.shellIndex?.disabled;
		if (reason)
			this.setShellWarning(`shell change tracking disabled: ${reason}`);
	}

	private setShellWarning(message: string): void {
		if (this.shellWarningIssued) return;
		if (this.shellWarning === null) {
			this.shellWarning = message;
			// Surface immediately: nothing polls captureWarning() today, and a
			// user relying on /undo should learn shell tracking is off right away.
			this.bus.emit({ type: "system:warning", message });
		}
	}

	/**
	 * A recorder that attributes every capture to `turnId`, regardless of the
	 * calling context's own turn. Sub-agents run on a private bus whose
	 * `turn:end` this store never sees, so journaling under their turn ids
	 * would leave checkpoints that are never finalized — invisible to /undo
	 * and /rewind, yet still swept up by restores of older checkpoints.
	 * Scoping to the spawning user turn folds their edits into the checkpoint
	 * that IS finalized. The view pins the root turn: re-scoping (a nested
	 * sub-agent) is a no-op.
	 */
	scopedToTurn(turnId: string): CheckpointRecorder {
		return scopeCheckpointRecorder(this, turnId);
	}

	// ------------------------------------------------------------------ query

	/**
	 * Finalized, non-empty turn checkpoints, newest first. Single pass over
	 * the journal: long sessions call this on every /undo //rewind, and a
	 * per-turn rescan is O(turns x records).
	 */
	listCheckpoints(): CheckpointSummary[] {
		interface TurnAccumulator {
			turn: TurnJournalRecord;
			files: string[];
			skippedFiles: string[];
			firstPre: Map<string, PreImageJournalRecord>;
			lastPost: Map<string, PostImageJournalRecord>;
		}
		const byTurn = new Map<string, TurnAccumulator>();
		for (const record of this.records) {
			if (record.type === "turn") {
				if (record.kind !== "redo-point" && !byTurn.has(record.turnId)) {
					byTurn.set(record.turnId, {
						turn: record,
						files: [],
						skippedFiles: [],
						firstPre: new Map(),
						lastPost: new Map(),
					});
				}
				continue;
			}
			if (
				record.type !== "pre" &&
				record.type !== "skip" &&
				record.type !== "post"
			)
				continue;
			const acc = byTurn.get(record.turnId);
			if (!acc) continue;
			const key = this.pathKey(record.path);
			if (record.type === "post") {
				acc.lastPost.set(key, record);
				continue;
			}
			if (acc.firstPre.has(key) || acc.skippedFiles.includes(record.path))
				continue;
			if (record.type === "skip" || record.unsupported) {
				acc.skippedFiles.push(record.path);
			} else {
				acc.files.push(record.path);
				acc.firstPre.set(key, record);
			}
		}
		const summaries: CheckpointSummary[] = [];
		for (const acc of byTurn.values()) {
			if (!this.finalizedTurns.has(acc.turn.turnId)) continue;
			if (acc.files.length === 0 && acc.skippedFiles.length === 0) continue;
			const added: string[] = [];
			const removed: string[] = [];
			const modified: string[] = [];
			for (const [key, pre] of acc.firstPre) {
				// No post record (tool died between pre and write): outcome unknown,
				// so leave the path out of the +/~/- counts. Restore is unaffected.
				const post = acc.lastPost.get(key);
				if (!post) continue;
				if (!pre.existed) {
					if (post.postHash !== null) added.push(pre.path);
				} else if (post.postHash === null) {
					removed.push(pre.path);
				} else {
					modified.push(pre.path);
				}
			}
			summaries.push({
				id: acc.turn.turnId,
				kind: "turn",
				label: acc.turn.label,
				ts: acc.turn.ts,
				files: acc.files,
				added,
				removed,
				modified,
				skippedFiles: acc.skippedFiles,
			});
		}
		return summaries.reverse();
	}

	/** The checkpoint the next `/undo` would restore, or null. */
	undoTarget(): string | null {
		const turns = this.listCheckpoints().reverse(); // oldest first
		const newest = turns.at(-1)?.id ?? null;
		const lastDone = findLast(
			this.records,
			(record): record is UndoDoneJournalRecord => record.type === "undo:done",
		);
		if (!lastDone) return newest;
		if (this.hasRealPreAfter(lastDone.seq)) return newest;
		const start = this.undoStartFor(lastDone.undoId);
		if (!start) return newest;
		const targetTurn = this.turnRecordFor(start.targetCheckpointId);
		if (targetTurn?.kind === "redo-point") {
			// The last restore was a /redo: undoing again re-targets the turn
			// whose undo created that redo point.
			const creator = findLast(
				this.records,
				(record): record is UndoStartJournalRecord =>
					record.type === "undo:start" &&
					record.redoCheckpointId === start.targetCheckpointId,
			);
			return creator?.targetCheckpointId ?? newest;
		}
		if (!targetTurn) return newest;
		// Walk back: the next undo targets the newest checkpoint older than the
		// one already restored.
		let older: string | null = null;
		for (const turn of turns) {
			const record = this.turnRecordFor(turn.id);
			if (record && record.seq < targetTurn.seq) older = turn.id;
		}
		return older;
	}

	/** The pending redo-point checkpoint, or null if consumed/invalidated. */
	redoTarget(): string | null {
		const lastDone = findLast(
			this.records,
			(record): record is UndoDoneJournalRecord => record.type === "undo:done",
		);
		if (!lastDone) return null;
		if (this.hasRealPreAfter(lastDone.seq)) return null;
		return lastDone.redoCheckpointId;
	}

	// ---------------------------------------------------------------- restore

	/**
	 * Resolves what restoring `checkpointId` would do to disk, per path:
	 * write the recorded pre-image, delete a file that did not exist, or skip
	 * (unsupported/too-large). `diverged` flags paths whose current disk
	 * content no longer matches the newest recorded post-image (hand edits).
	 */
	async planRestore(checkpointId: string): Promise<RestorePlan> {
		const turn = this.turnRecordFor(checkpointId);
		if (!turn) throw new Error(`Unknown checkpoint: ${checkpointId}`);
		const composed = this.composeEntries(turn);
		const entries: RestorePlanEntry[] = [];
		for (const record of composed.values()) {
			entries.push(await this.planEntry(record));
		}
		return { checkpointId, entries };
	}

	/**
	 * Applies a restore plan. Divergence-respecting when `skipDiverged`;
	 * write-ahead journaled (crash-safe); atomic per file via temp+rename in
	 * the target directory; never clobbers symlinks/non-regular files. When
	 * restoring a turn checkpoint, current content is first captured into a
	 * synthetic redo-point checkpoint so `/redo` can reapply it.
	 */
	async restore(
		plan: RestorePlan,
		opts: { skipDiverged: boolean },
	): Promise<RestoreResult> {
		await this.recoverIfNeeded();

		const applied: RestorePlanEntry[] = [];
		const skipped: Array<{ path: string; reason: string }> = [];
		for (const entry of plan.entries) {
			if (entry.action === "skip-unsupported") {
				skipped.push({ path: entry.path, reason: "unsupported" });
			} else if (entry.action === "skip-too-large") {
				skipped.push({ path: entry.path, reason: "too_large" });
			} else if (entry.diverged && opts.skipDiverged) {
				skipped.push({ path: entry.path, reason: "diverged" });
			} else {
				applied.push(entry);
			}
		}

		const result: RestoreResult = {
			checkpointId: plan.checkpointId,
			restored: [],
			deleted: [],
			skipped,
			redoCheckpointId: null,
		};
		if (applied.length === 0) {
			this.emitRestored(plan.checkpointId, 0, skipped.length);
			return result;
		}

		const undoId = shortId("undo");
		const targetTurn = this.turnRecordFor(plan.checkpointId);
		if (targetTurn && targetTurn.kind !== "redo-point") {
			result.redoCheckpointId = await this.captureRedoPoint(
				applied,
				undoId,
				targetTurn,
			);
		}

		// Write-ahead marker: flushed with the full resolved plan before any
		// disk mutation so recoverIfNeeded() can replay it after a crash. The
		// workspace-level pointer file lets the NEXT process find this session's
		// journal (every launch mints a fresh session dir), so recovery also
		// survives a hard crash that kills the process mid-restore.
		this.append({
			type: "undo:start",
			undoId,
			targetCheckpointId: plan.checkpointId,
			redoCheckpointId: result.redoCheckpointId,
			skipDiverged: opts.skipDiverged,
			files: applied,
		});
		await this.writePendingUndoPointer(undoId);
		await this.journal.flush();

		await withPathLocks(
			applied.map((entry) => entry.path),
			async () => {
				for (const entry of applied) {
					let outcome: PlanEntryOutcome;
					try {
						outcome = await this.applyPlanEntry(entry, undoId, opts);
					} catch (error) {
						// One unwritable path (EACCES, missing blob, ENOSPC) must not
						// wedge the restore — and with it every future /undo, /redo and
						// /rewind: report it skipped and keep going so undo:done lands.
						result.skipped.push({
							path: entry.path,
							reason: restoreFailureReason(error),
						});
						continue;
					}
					if (outcome === "restored") result.restored.push(entry.path);
					else if (outcome === "deleted") result.deleted.push(entry.path);
					else result.skipped.push({ path: entry.path, reason: outcome });
				}
			},
		);

		this.append({
			type: "undo:done",
			undoId,
			redoCheckpointId: result.redoCheckpointId,
		});
		await this.journal.flush();
		await this.clearPendingUndoPointerIfOwned();
		this.emitRestored(
			plan.checkpointId,
			result.restored.length + result.deleted.length,
			result.skipped.length,
		);
		return result;
	}

	/**
	 * Replays any restore that has an `undo:start` marker but no `undo:done`
	 * (crash mid-restore). Every step is idempotent; call at load and before
	 * any new restore.
	 */
	async recoverIfNeeded(): Promise<void> {
		const doneIds = new Set(
			this.records
				.filter((record) => record.type === "undo:done")
				.map((record) => record.undoId),
		);
		const incomplete = this.records.filter(
			(record): record is UndoStartJournalRecord =>
				record.type === "undo:start" && !doneIds.has(record.undoId),
		);
		for (const start of incomplete) {
			const completed = new Set(
				this.records
					.filter(
						(record): record is UndoFileJournalRecord =>
							record.type === "undo:file" && record.undoId === start.undoId,
					)
					.map((record) => this.pathKey(record.path)),
			);
			let files = 0;
			let skipped = 0;
			await withPathLocks(
				start.files.map((entry) => entry.path),
				async () => {
					for (const entry of start.files) {
						if (completed.has(this.pathKey(entry.path))) {
							files += 1;
							continue;
						}
						let outcome: PlanEntryOutcome;
						try {
							outcome = await this.applyPlanEntry(entry, start.undoId, {
								skipDiverged: start.skipDiverged ?? false,
							});
						} catch {
							// A persistently failing path must not poison the marker and
							// wedge every future restore; skip it and complete the undo.
							skipped += 1;
							continue;
						}
						if (outcome === "restored" || outcome === "deleted") files += 1;
						else skipped += 1;
					}
				},
			);
			this.append({
				type: "undo:done",
				undoId: start.undoId,
				redoCheckpointId: start.redoCheckpointId,
			});
			await this.journal.flush();
			this.emitRestored(start.targetCheckpointId, files, skipped);
		}
		await this.clearPendingUndoPointerIfOwned();
	}

	/**
	 * Follows the workspace `pending-undo.json` pointer (if any) to the
	 * session whose restore a crashed process left half-applied, replays it to
	 * completion and clears the pointer. Every launch mints a fresh session
	 * dir, so without this a dangling `undo:start` in the dead session's
	 * journal would never be seen again and the workspace would stay
	 * half-restored. A pointer owned by a still-running process is left alone.
	 */
	static async recoverAbandonedRestore(pendingUndoPath: string): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(pendingUndoPath, "utf8");
		} catch {
			return;
		}
		let pointer: PendingUndoPointer = {};
		try {
			pointer = JSON.parse(raw) as PendingUndoPointer;
		} catch {
			// Corrupt pointer: nothing to replay; fall through and remove it.
		}
		if (!pointer.sessionRoot) {
			await rm(pendingUndoPath, { force: true });
			return;
		}
		if (
			typeof pointer.pid === "number" &&
			pointer.pid !== process.pid &&
			isProcessAlive(pointer.pid)
		) {
			return;
		}
		const store = new CheckpointStore(
			sessionPathsForRoot(pointer.sessionRoot),
			new EventBus(),
		);
		await store.recoverIfNeeded();
		await store.flush();
		store.dispose();
		await rm(pendingUndoPath, { force: true });
	}

	// -------------------------------------------------------------- internals

	private loadExistingJournal(): void {
		let raw: string;
		try {
			raw = readFileSync(join(this.paths.checkpoints, "journal.jsonl"), "utf8");
		} catch {
			return;
		}
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line) as JournalRecord;
				this.records.push(record);
				this.indexRecord(record);
				if (record.seq >= this.seq) this.seq = record.seq + 1;
			} catch {
				// A crash can truncate the final line; ignore it.
			}
		}
	}

	private indexRecord(record: JournalRecord): void {
		if (record.type === "turn") {
			if (!this.turnIndex.has(record.turnId))
				this.turnIndex.set(record.turnId, record);
		} else if (record.type === "finalize") {
			this.finalizedTurns.add(record.turnId);
		} else if (record.type === "pre" || record.type === "skip") {
			this.turnsWithEntries.add(record.turnId);
		} else if (record.type === "post") {
			this.latestPostByPath.set(this.pathKey(record.path), record);
		}
	}

	private append<T extends JournalRecord["type"]>(
		record: Omit<Extract<JournalRecord, { type: T }>, "seq" | "ts"> & {
			type: T;
		},
	): void {
		const full = {
			...record,
			seq: this.seq++,
			ts: new Date().toISOString(),
		} as unknown as JournalRecord;
		this.records.push(full);
		this.indexRecord(full);
		this.journal.write(full);
	}

	private ensureTurn(turnId: string): void {
		if (this.turnRecordFor(turnId)) return;
		this.append({ type: "turn", turnId, label: this.pendingLabel });
	}

	private finalizeTurn(turnId: string, status: "ok" | "cancelled"): void {
		if (!this.turnRecordFor(turnId)) return;
		if (this.finalizedTurns.has(turnId)) return;
		const hasEntries = this.turnsWithEntries.has(turnId);
		this.append({
			type: "finalize",
			turnId,
			status: hasEntries ? status : "empty",
		});
	}

	private turnRecordFor(turnId: string): TurnJournalRecord | undefined {
		return this.turnIndex.get(turnId);
	}

	private undoStartFor(undoId: string): UndoStartJournalRecord | undefined {
		return this.records.find(
			(record): record is UndoStartJournalRecord =>
				record.type === "undo:start" && record.undoId === undoId,
		);
	}

	/** Case-normalized comparison key (darwin/win32 are case-insensitive). */
	private pathKey(path: string): string {
		const resolved = resolve(path);
		return process.platform === "darwin" || process.platform === "win32"
			? resolved.toLowerCase()
			: resolved;
	}

	/** True if any agent-authored pre-image landed after `seq` (redo killer). */
	private hasRealPreAfter(seq: number): boolean {
		return this.records.some(
			(record) =>
				record.seq > seq &&
				((record.type === "pre" && record.tool !== REDO_TOOL) ||
					record.type === "skip"),
		);
	}

	/**
	 * Oldest pre/skip record per path across eligible turns. For a turn
	 * checkpoint: every turn-kind checkpoint at or after the target (synthetic
	 * redo-point captures are excluded). For a redo-point: its own entries.
	 */
	private composeEntries(
		target: TurnJournalRecord,
	): Map<string, PreImageJournalRecord | SkipJournalRecord> {
		const composed = new Map<
			string,
			PreImageJournalRecord | SkipJournalRecord
		>();
		for (const record of this.records) {
			if (record.type !== "pre" && record.type !== "skip") continue;
			if (target.kind === "redo-point") {
				if (record.turnId !== target.turnId) continue;
			} else {
				const owner = this.turnRecordFor(record.turnId);
				if (owner?.kind === "redo-point") continue;
				const ownerSeq = owner?.seq ?? record.seq;
				if (ownerSeq < target.seq) continue;
			}
			const key = this.pathKey(record.path);
			if (!composed.has(key)) composed.set(key, record);
		}
		return composed;
	}

	private async planEntry(
		record: PreImageJournalRecord | SkipJournalRecord,
	): Promise<RestorePlanEntry> {
		if (record.type === "skip") {
			return { path: record.path, action: "skip-too-large", diverged: false };
		}
		if (record.unsupported) {
			return { path: record.path, action: "skip-unsupported", diverged: false };
		}
		const disk = await this.diskState(record.path);
		if (disk.kind === "other") {
			// The path is now a symlink/directory/etc; never clobber it.
			return { path: record.path, action: "skip-unsupported", diverged: false };
		}
		const newestPost = this.latestPostByPath.get(this.pathKey(record.path));
		const diverged = newestPost
			? disk.kind === "file"
				? disk.hash !== newestPost.postHash
				: newestPost.postHash !== null
			: false;
		if (record.existed) {
			return {
				path: record.path,
				action: "write",
				diverged,
				...(record.hash ? { hash: record.hash } : {}),
				...(record.mode !== undefined ? { mode: record.mode } : {}),
			};
		}
		return {
			path: record.path,
			action: "delete",
			diverged,
			...(record.createdDirs ? { createdDirs: record.createdDirs } : {}),
		};
	}

	private async diskState(path: string): Promise<DiskState> {
		const stats = await lstatOrNull(path);
		if (!stats) return { kind: "absent" };
		if (!stats.isFile()) return { kind: "other" };
		return {
			kind: "file",
			hash: sha256Hex(await readFile(path)),
			mode: stats.mode & 0o777,
		};
	}

	/**
	 * Captures the current content of every to-change path into a synthetic
	 * redo-point checkpoint (journaled before the undo marker so a crash
	 * cannot lose the redo state).
	 */
	private async captureRedoPoint(
		entries: RestorePlanEntry[],
		undoId: string,
		target: TurnJournalRecord,
	): Promise<string> {
		const redoId = shortId("redo");
		this.append({
			type: "turn",
			turnId: redoId,
			label: target.label ? `redo of "${target.label}"` : "redo point",
			kind: "redo-point",
		});
		for (const entry of entries) {
			const stats = await lstatOrNull(entry.path);
			if (!stats) {
				this.append({
					type: "pre",
					turnId: redoId,
					toolCallId: undoId,
					tool: REDO_TOOL,
					path: entry.path,
					existed: false,
				});
			} else if (!stats.isFile()) {
				this.append({
					type: "pre",
					turnId: redoId,
					toolCallId: undoId,
					tool: REDO_TOOL,
					path: entry.path,
					existed: true,
					unsupported: true,
				});
			} else if (stats.size > MAX_CAPTURE_BYTES) {
				this.append({
					type: "skip",
					turnId: redoId,
					toolCallId: undoId,
					path: entry.path,
					reason: "too_large",
					size: stats.size,
				});
			} else {
				const content = await readFile(entry.path);
				const hash = await this.blobs.put(content);
				this.append({
					type: "pre",
					turnId: redoId,
					toolCallId: undoId,
					tool: REDO_TOOL,
					path: entry.path,
					existed: true,
					hash,
					size: stats.size,
					mode: stats.mode & 0o777,
				});
			}
		}
		this.append({ type: "finalize", turnId: redoId, status: "ok" });
		await this.journal.flush();
		return redoId;
	}

	/**
	 * Applies one plan entry to disk (idempotent) and journals the progress
	 * marker plus a post record so later divergence checks stay accurate.
	 * When the caller asked to skip diverged files, divergence is re-checked
	 * here — under the path lock, at apply time — because the plan's flags
	 * were computed when the command was issued and the confirm picker can
	 * sit open while the user keeps editing.
	 */
	private async applyPlanEntry(
		entry: RestorePlanEntry,
		undoId: string,
		opts: { skipDiverged: boolean },
	): Promise<PlanEntryOutcome> {
		if (
			entry.action === "skip-unsupported" ||
			entry.action === "skip-too-large"
		)
			return "unsupported";
		const current = await lstatOrNull(entry.path);
		if (current && !current.isFile()) return "unsupported";
		if (
			opts.skipDiverged &&
			(await this.divergedSinceLastPostImage(entry, current !== null))
		) {
			return "diverged";
		}

		let postHash: string | null;
		let outcome: "restored" | "deleted";
		if (entry.action === "delete") {
			await unlinkTolerant(entry.path);
			await pruneCreatedDirs(entry.createdDirs);
			postHash = null;
			outcome = "deleted";
		} else {
			if (!entry.hash) throw new Error(`Missing blob hash for ${entry.path}`);
			const content = await this.blobs.get(entry.hash);
			await writeAtomically(entry.path, content, entry.mode);
			postHash = entry.hash;
			outcome = "restored";
		}
		this.append({ type: "undo:file", undoId, path: entry.path });
		this.append({
			type: "post",
			turnId: undoId,
			toolCallId: undoId,
			path: entry.path,
			postHash,
		});
		return outcome;
	}

	/**
	 * True when the disk content was hand-edited after the plan was computed:
	 * it matches neither the entry's target state (already applied — an
	 * idempotent crash replay) nor the newest recorded post-image.
	 */
	private async divergedSinceLastPostImage(
		entry: RestorePlanEntry,
		exists: boolean,
	): Promise<boolean> {
		const currentHash = exists ? sha256Hex(await readFile(entry.path)) : null;
		const targetHash = entry.action === "delete" ? null : (entry.hash ?? null);
		if (currentHash === targetHash) return false;
		const newestPost = this.latestPostByPath.get(this.pathKey(entry.path));
		if (!newestPost) return false;
		return currentHash !== newestPost.postHash;
	}

	/**
	 * Durable workspace-level pointer to this session while a restore is in
	 * flight. Written before the `undo:start` flush so a crash at any point
	 * leaves either a pointer with nothing to replay (harmless) or a pointer
	 * naming the journal that `recoverAbandonedRestore()` must finish.
	 */
	private async writePendingUndoPointer(undoId: string): Promise<void> {
		const pointer: PendingUndoPointer = {
			sessionRoot: this.paths.root,
			undoId,
			pid: process.pid,
		};
		await writeFile(this.paths.pendingUndo, JSON.stringify(pointer), "utf8");
	}

	/** Removes the pointer, but never another live session's. */
	private async clearPendingUndoPointerIfOwned(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.paths.pendingUndo, "utf8");
		} catch {
			return;
		}
		try {
			const pointer = JSON.parse(raw) as PendingUndoPointer;
			if (pointer.sessionRoot !== this.paths.root) return;
		} catch {
			// Corrupt pointer: fall through and remove it.
		}
		await rm(this.paths.pendingUndo, { force: true });
	}

	/** Restores a single pre-image record (used by `revertToolCall`). */
	private async applyPreImage(
		pre: PreImageJournalRecord,
	): Promise<string | null> {
		if (!pre.existed) {
			await unlinkTolerant(pre.path);
			await pruneCreatedDirs(pre.createdDirs);
			return null;
		}
		if (!pre.hash) throw new Error(`Missing blob hash for ${pre.path}`);
		const content = await this.blobs.get(pre.hash);
		await writeAtomically(pre.path, content, pre.mode);
		return pre.hash;
	}

	private emitRestored(
		checkpointId: string,
		files: number,
		skipped: number,
	): void {
		this.bus.emit({
			type: "checkpoint:restored",
			checkpointId,
			files,
			skipped,
		});
	}
}

// ------------------------------------------------------------- fs helpers

type PlanEntryOutcome = "restored" | "deleted" | "unsupported" | "diverged";

async function lstatOrNull(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return null;
		throw error;
	}
}

/** Skip reason for a path whose restore failed (shown to the user). */
function restoreFailureReason(error: unknown): string {
	if (isErrnoException(error) && error.code) return `error: ${error.code}`;
	return `error: ${errorMessage(error)}`;
}

/** Removes journaled created dirs, deepest first, only while empty. */
async function pruneCreatedDirs(dirs?: string[]): Promise<void> {
	if (!dirs?.length) return;
	const deepestFirst = [...dirs].sort((a, b) => b.length - a.length);
	for (const dir of deepestFirst) {
		try {
			await rmdir(dir);
		} catch {
			// Not empty, already gone, or otherwise unremovable: leave it.
		}
	}
}

/**
 * Writes `content` via a temp file in the TARGET's directory (same-volume
 * atomic rename), with an unlink+rename fallback on EEXIST/EPERM and one
 * retry on EBUSY (Windows AV scanners). `chmod` is best-effort.
 */
async function writeAtomically(
	path: string,
	content: Uint8Array,
	mode?: number,
): Promise<void> {
	const dir = dirname(path);
	await ensureDir(dir);
	const temp = join(dir, `.${shortId("ckpt")}`);
	try {
		await writeFile(temp, content);
		if (mode !== undefined) {
			try {
				await chmod(temp, mode);
			} catch {
				// Best-effort; a no-op on Windows.
			}
		}
		await renameOver(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function findLast<T extends JournalRecord>(
	records: readonly JournalRecord[],
	predicate: (record: JournalRecord) => record is T,
): T | undefined;
function findLast(
	records: readonly JournalRecord[],
	predicate: (record: JournalRecord) => boolean,
): JournalRecord | undefined;
function findLast(
	records: readonly JournalRecord[],
	predicate: (record: JournalRecord) => boolean,
): JournalRecord | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record && predicate(record)) return record;
	}
	return undefined;
}
