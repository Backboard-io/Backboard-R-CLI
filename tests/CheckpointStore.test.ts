import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync } from "node:fs";
import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { sha256Hex } from "../src/core/checkpoints/blobStore.ts";
import {
	CheckpointStore,
	MAX_CAPTURE_BYTES,
	revocableRecorder,
} from "../src/core/checkpoints/CheckpointStore.ts";
import type { SessionPaths } from "../src/core/session/SessionStore.ts";

let root: string;
let work: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ckpt-test-"));
	work = join(root, "work");
	await mkdir(work, { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function sessionPaths(): SessionPaths {
	const session = join(root, "session");
	const checkpoints = join(session, "checkpoints");
	return {
		root: session,
		clientLog: join(session, "client.jsonl"),
		serverLog: join(session, "server.jsonl"),
		meta: join(session, "meta.json"),
		checkpoints,
		// Like the real layout: objects + pointer shared next to session dirs.
		checkpointObjects: join(root, "objects"),
		pendingUndo: join(root, "pending-undo.json"),
	};
}

function makeStore(paths = sessionPaths()) {
	const bus = new EventBus();
	const store = new CheckpointStore(paths, bus);
	return { bus, store, paths };
}

function startTurn(bus: EventBus, turnId: string, label = "test turn"): void {
	bus.emit({ type: "user:message", text: label });
	bus.emit({ type: "turn:start", turnId });
}

function endTurn(bus: EventBus, turnId: string): void {
	bus.emit({ type: "turn:end", turnId, status: "completed", durationMs: 1 });
}

const ctx = (turnId: string, toolCallId: string) => ({ turnId, toolCallId });

/** Reaches the private per-tool-call begin snapshots to assert they are freed. */
function shellBeginCount(store: CheckpointStore): number {
	return (store as unknown as { shellBegins: Map<string, unknown> }).shellBegins
		.size;
}

async function undoLatest(store: CheckpointStore, skipDiverged = false) {
	const target = store.undoTarget();
	if (!target) throw new Error("expected an undo target");
	return store.restore(await store.planRestore(target), { skipDiverged });
}

describe("CheckpointStore", () => {
	it("undoes a new file by deleting it and pruning only empty createdDirs", async () => {
		const { bus, store } = makeStore();
		const dirA = join(work, "a");
		const dirB = join(dirA, "b");
		const file = join(dirB, "new.txt");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), {
			createdDirs: [dirA, dirB],
			tool: "Write",
		});
		await mkdir(dirB, { recursive: true });
		await writeFile(file, "created", "utf8");
		// A stray user file inside a created dir must block that dir's prune.
		const stray = join(dirA, "keep.txt");
		await writeFile(stray, "user data", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("created"));
		endTurn(bus, "t1");

		const result = await undoLatest(store);

		expect(result.deleted).toEqual([file]);
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dirB)).toBe(false); // empty createdDir pruned
		expect(existsSync(dirA)).toBe(true); // non-empty createdDir kept
		expect(existsSync(stray)).toBe(true);
		expect(existsSync(work)).toBe(true); // never touches non-created dirs
	});

	it("restores true turn-start content for multi-edit turns (first pre-image wins)", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		await store.recordPreImage(file, ctx("t1", "c2"), { tool: "Edit" });
		await writeFile(file, "v2", "utf8");
		await store.recordPostImage(file, ctx("t1", "c2"), Buffer.from("v2"));
		endTurn(bus, "t1");

		await undoLatest(store);

		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("undoes an ApplyPatch move: source recreated, destination deleted", async () => {
		const { bus, store } = makeStore();
		const src = join(work, "src.txt");
		const dst = join(work, "dst.txt");
		await writeFile(src, "moved content", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(src, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await store.recordPreImage(dst, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await unlink(src);
		await writeFile(dst, "moved content", "utf8");
		await store.recordPostImage(src, ctx("t1", "c1"));
		await store.recordPostImage(
			dst,
			ctx("t1", "c1"),
			Buffer.from("moved content"),
		);
		endTurn(bus, "t1");

		await undoLatest(store);

		expect(await readFile(src, "utf8")).toBe("moved content");
		expect(existsSync(dst)).toBe(false);
	});

	it("detects divergence and honors skipDiverged", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		// User hand-edits after the agent's write.
		await writeFile(file, "hand edited", "utf8");

		const target = store.undoTarget();
		if (!target) throw new Error("expected an undo target");
		const plan = await store.planRestore(target);
		expect(plan.entries).toHaveLength(1);
		expect(plan.entries[0]?.diverged).toBe(true);

		const skippedResult = await store.restore(plan, { skipDiverged: true });
		expect(skippedResult.restored).toEqual([]);
		expect(skippedResult.skipped).toEqual([{ path: file, reason: "diverged" }]);
		expect(await readFile(file, "utf8")).toBe("hand edited");

		const forcedResult = await store.restore(plan, { skipDiverged: false });
		expect(forcedResult.restored).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("replays an interrupted restore (undo:start without undo:done) idempotently", async () => {
		const { bus, store, paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");
		await store.flush();

		// Simulate a crash mid-restore: the write-ahead marker landed in the
		// journal, but no disk mutation nor undo:done happened.
		const crashRecord = {
			type: "undo:start",
			undoId: "undo_crash",
			targetCheckpointId: "t1",
			redoCheckpointId: null,
			files: [
				{
					path: file,
					action: "write",
					diverged: false,
					hash: sha256Hex(Buffer.from("v0")),
					mode: 0o644,
				},
			],
			seq: 999,
			ts: new Date().toISOString(),
		};
		await appendFile(
			join(paths.checkpoints, "journal.jsonl"),
			`${JSON.stringify(crashRecord)}\n`,
		);

		const reloaded = makeStore(paths).store;
		await reloaded.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");

		// Re-running recovery is a no-op.
		await reloaded.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");

		// A store loaded after recovery sees the undo:done marker on disk.
		const reloadedAgain = makeStore(paths).store;
		await reloadedAgain.recoverIfNeeded();
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("round-trips CRLF/BOM/binary content byte-exactly", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.bin");
		const original = Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]), // BOM
			Buffer.from("line one\r\nline two\r", "latin1"),
			Buffer.from([0x00, 0xff, 0x10, 0x80]), // binary bytes
		]);
		await writeFile(file, original);

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Write" });
		await writeFile(file, "plain utf8 replacement\n", "utf8");
		await store.recordPostImage(
			file,
			ctx("t1", "c1"),
			Buffer.from("plain utf8 replacement\n"),
		);
		endTurn(bus, "t1");

		await undoLatest(store);

		const restored = await readFile(file);
		expect(restored.equals(original)).toBe(true);
	});

	it("restores a redo point and invalidates it on a new agent write", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const undoResult = await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
		expect(undoResult.redoCheckpointId).not.toBeNull();
		expect(store.redoTarget()).toBe(undoResult.redoCheckpointId ?? "");

		// Redo reapplies the undone state...
		const redoTarget = store.redoTarget();
		if (!redoTarget) throw new Error("expected a redo target");
		await store.restore(await store.planRestore(redoTarget), {
			skipDiverged: false,
		});
		expect(await readFile(file, "utf8")).toBe("v1");
		// ...and /undo targets the same turn again after a redo.
		expect(store.undoTarget()).toBe("t1");

		// A fresh undo re-arms redo; a new agent write invalidates it.
		await undoLatest(store);
		expect(store.redoTarget()).not.toBeNull();
		startTurn(bus, "t2");
		const other = join(work, "g.txt");
		await store.recordPreImage(other, ctx("t2", "c2"), { tool: "Write" });
		await writeFile(other, "new", "utf8");
		await store.recordPostImage(other, ctx("t2", "c2"), Buffer.from("new"));
		endTurn(bus, "t2");
		expect(store.redoTarget()).toBeNull();
	});

	it("journals a too_large skip for oversized files and reports them non-revertible", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "huge.bin");
		await writeFile(file, Buffer.alloc(MAX_CAPTURE_BYTES + 1));

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Write" });
		await writeFile(file, "shrunk", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("shrunk"));
		endTurn(bus, "t1");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.skippedFiles).toEqual([file]);

		const plan = await store.planRestore("t1");
		expect(plan.entries).toEqual([
			{ path: file, action: "skip-too-large", diverged: false },
		]);

		const result = await store.restore(plan, { skipDiverged: false });
		expect(result.skipped).toEqual([{ path: file, reason: "too_large" }]);
		expect(await readFile(file, "utf8")).toBe("shrunk"); // untouched
	}, 30_000);

	it("never clobbers symlinks: captured as unsupported and skipped on restore", async () => {
		const { bus, store } = makeStore();
		const target = join(work, "target.txt");
		const link = join(work, "link.txt");
		await writeFile(target, "real", "utf8");
		await symlink(target, link);

		startTurn(bus, "t1");
		await store.recordPreImage(link, ctx("t1", "c1"), { tool: "Edit" });
		await store.recordPostImage(link, ctx("t1", "c1"));
		endTurn(bus, "t1");

		const plan = await store.planRestore("t1");
		expect(plan.entries).toEqual([
			{ path: link, action: "skip-unsupported", diverged: false },
		]);

		const result = await store.restore(plan, { skipDiverged: false });
		expect(result.skipped).toEqual([{ path: link, reason: "unsupported" }]);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe("real");
	});

	it("rolls back a mid-loop ApplyPatch failure via revertToolCall", async () => {
		const { bus, store } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a v0", "utf8");

		startTurn(bus, "t1");
		// Pre-images for every action path are captured up front.
		await store.recordPreImage(fileA, ctx("t1", "c1"), { tool: "ApplyPatch" });
		await store.recordPreImage(fileB, ctx("t1", "c1"), { tool: "ApplyPatch" });
		// First two writes land, then the patch loop "fails".
		await writeFile(fileA, "a v1", "utf8");
		await store.recordPostImage(fileA, ctx("t1", "c1"), Buffer.from("a v1"));
		await writeFile(fileB, "b created", "utf8");

		await store.revertToolCall("c1");

		expect(await readFile(fileA, "utf8")).toBe("a v0");
		expect(existsSync(fileB)).toBe(false);
	});

	it("walks back through checkpoints on repeated undo and composes across turns", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1", "first change");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		startTurn(bus, "t2", "second change");
		await store.recordPreImage(file, ctx("t2", "c2"), { tool: "Edit" });
		await writeFile(file, "v2", "utf8");
		await store.recordPostImage(file, ctx("t2", "c2"), Buffer.from("v2"));
		endTurn(bus, "t2");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual([
			"t2",
			"t1",
		]);
		expect(checkpoints[0]?.label).toBe("second change");
		expect(checkpoints[0]?.files).toEqual([file]);

		expect(store.undoTarget()).toBe("t2");
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v1");

		expect(store.undoTarget()).toBe("t1");
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");

		expect(store.undoTarget()).toBeNull();
	});

	it("folds sub-agent edits into the parent turn via scopedToTurn", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "sub.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "parent", "delegate work");
		// The sub-agent journals under its own turn ids, which are never
		// finalized on the main bus; the scoped recorder re-attributes them.
		const recorder = store.scopedToTurn("parent");
		// A nested sub-agent re-scopes; the root attribution must win.
		const nested = recorder.scopedToTurn("sub-turn-2");
		await nested.recordPreImage(file, ctx("sub-turn-1", "c1"), {
			tool: "Edit",
		});
		await writeFile(file, "v1", "utf8");
		await nested.recordPostImage(
			file,
			ctx("sub-turn-1", "c1"),
			Buffer.from("v1"),
		);
		endTurn(bus, "parent"); // only the parent turn ever finalizes

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.id).toBe("parent");
		expect(checkpoints[0]?.files).toEqual([file]);

		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("refuses an uncapturable pre-image when requireRevertible is set", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "huge.bin");
		await writeFile(file, Buffer.alloc(MAX_CAPTURE_BYTES + 1), "utf8");

		startTurn(bus, "t1");
		await expect(
			store.recordPreImage(file, ctx("t1", "c1"), {
				tool: "ApplyPatch",
				requireRevertible: true,
			}),
		).rejects.toThrow(/could not be rolled back/);
		endTurn(bus, "t1");

		// No skip entry was journaled: the turn stays empty and unlisted.
		expect(store.listCheckpoints()).toEqual([]);
	}, 30_000);

	it("skips a path whose restore fails and still completes the undo", async () => {
		const { bus, store, paths } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a0", "utf8");
		await writeFile(fileB, "b0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(fileA, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(fileA, "a1", "utf8");
		await store.recordPostImage(fileA, ctx("t1", "c1"), Buffer.from("a1"));
		await store.recordPreImage(fileB, ctx("t1", "c2"), { tool: "Edit" });
		await writeFile(fileB, "b1", "utf8");
		await store.recordPostImage(fileB, ctx("t1", "c2"), Buffer.from("b1"));
		endTurn(bus, "t1");

		// Corrupt the blob store: fileA's pre-image blob goes missing.
		const hashA = sha256Hex(Buffer.from("a0"));
		await rm(join(paths.checkpointObjects, hashA.slice(0, 2), hashA), {
			force: true,
		});

		const result = await undoLatest(store);
		expect(result.restored).toEqual([fileB]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]?.path).toBe(fileA);
		expect(result.skipped[0]?.reason).toMatch(/^error: /);
		expect(await readFile(fileB, "utf8")).toBe("b0");
		expect(await readFile(fileA, "utf8")).toBe("a1"); // untouched

		// The undo completed (undo:done landed): nothing dangles, and redo
		// plus further restores keep working.
		await store.recoverIfNeeded();
		expect(await readFile(fileB, "utf8")).toBe("b0");
		expect(store.redoTarget()).not.toBeNull();
	});

	it("re-checks divergence under the lock at apply time", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const plan = await store.planRestore("t1");
		expect(plan.entries[0]?.diverged).toBe(false);

		// Hand edit while the confirm picker sits open: the stale plan says
		// clean, but "skip hand-edited files" must still protect the edit.
		await writeFile(file, "hand edited", "utf8");
		const skipping = await store.restore(plan, { skipDiverged: true });
		expect(skipping.restored).toEqual([]);
		expect(skipping.skipped).toEqual([{ path: file, reason: "diverged" }]);
		expect(await readFile(file, "utf8")).toBe("hand edited");

		// "Revert all" still clobbers, as the user explicitly asked.
		const forced = await store.restore(plan, { skipDiverged: false });
		expect(forced.restored).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("completes a crashed process's restore via the pending-undo pointer", async () => {
		const { bus, store, paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");
		await store.flush();

		// Simulate a hard crash mid-restore in another (now dead) process: the
		// journal holds a dangling undo:start and the workspace pointer names
		// this session. A fresh launch never reloads the old journal itself —
		// it must follow the pointer.
		const crashRecord = {
			type: "undo:start",
			undoId: "undo_crash",
			targetCheckpointId: "t1",
			redoCheckpointId: null,
			skipDiverged: false,
			files: [
				{
					path: file,
					action: "write",
					diverged: false,
					hash: sha256Hex(Buffer.from("v0")),
					mode: 0o644,
				},
			],
			seq: 999,
			ts: new Date().toISOString(),
		};
		await appendFile(
			join(paths.checkpoints, "journal.jsonl"),
			`${JSON.stringify(crashRecord)}\n`,
		);
		await writeFile(
			paths.pendingUndo,
			JSON.stringify({
				sessionRoot: paths.root,
				undoId: "undo_crash",
				pid: 999999999, // long dead
			}),
			"utf8",
		);

		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);

		expect(await readFile(file, "utf8")).toBe("v0");
		expect(existsSync(paths.pendingUndo)).toBe(false);

		// Idempotent: a second recovery pass finds nothing to do.
		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("leaves a live process's pending-undo pointer alone", async () => {
		const { paths } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v1", "utf8");
		await mkdir(paths.checkpoints, { recursive: true });
		await writeFile(
			paths.pendingUndo,
			JSON.stringify({
				sessionRoot: paths.root,
				undoId: "undo_live",
				pid: 1, // init/launchd: alive (EPERM), not this process
			}),
			"utf8",
		);

		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);

		expect(existsSync(paths.pendingUndo)).toBe(true);
		expect(await readFile(file, "utf8")).toBe("v1");
	});

	it("emits checkpoint:restored on the bus", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		const events: Array<{ checkpointId: string; files: number }> = [];
		bus.on("checkpoint:restored", (event) => {
			events.push({ checkpointId: event.checkpointId, files: event.files });
		});
		await undoLatest(store);

		expect(events).toEqual([{ checkpointId: "t1", files: 1 }]);
	});
});

describe("revocableRecorder", () => {
	it("stops journaling into the turn once revoked", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		revoke();
		await recorder.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await recorder.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toHaveLength(0);
	});

	it("still rolls back a tool call it pre-imaged before revocation", async () => {
		const { bus, store } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		await recorder.recordPreImage(fileA, ctx("t1", "c1"), {
			tool: "ApplyPatch",
		});
		await recorder.recordPreImage(fileB, ctx("t1", "c1"), {
			tool: "ApplyPatch",
		});
		await writeFile(fileA, "a v1", "utf8");
		await recorder.recordPostImage(fileA, ctx("t1", "c1"), Buffer.from("a v1"));
		await writeFile(fileB, "b created", "utf8");

		revoke();
		await recorder.revertToolCall("c1");

		expect(await readFile(fileA, "utf8")).toBe("a v0");
		expect(existsSync(fileB)).toBe(false);
	});

	it("drops a pre-image whose write was still pending when it was revoked", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		// The capture returns, then the run is backgrounded before its write.
		await recorder.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await revoke();
		await writeFile(file, "background result", "utf8");
		await recorder.recordPostImage(file, ctx("t1", "c1"), Buffer.from("bg"));
		endTurn(bus, "t1");

		// Nothing left for the turn to own, so /undo cannot clobber the write.
		expect(store.listCheckpoints()).toHaveLength(0);
		expect(await readFile(file, "utf8")).toBe("background result");
	});

	it("keeps a pre-image its post-image already settled", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		await recorder.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await recorder.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		await revoke();
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toHaveLength(1);
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("ignores a revoke for an entry journaled by another session's store", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		await store.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await store.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		// A run that outlived a session switch revokes through the manager into
		// this store with a seq that only meant something in its own journal.
		const foreign = store.listCheckpoints()[0];
		expect(foreign).toBeDefined();
		await store.revokeCapture({
			journalRoot: join(root, "elsewhere"),
			turnId: "t1",
			ref: 1,
			path: file,
		});

		expect(store.listCheckpoints()).toHaveLength(1);
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("keeps a write that finished before revocation even if its post-image had not landed", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		await recorder.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		// The handoff lands while the post-image is still being recorded.
		const post = recorder.recordPostImage(file, ctx("t1", "c1"));
		await revoke();
		await post;
		endTurn(bus, "t1");

		// The write happened under the turn, so /undo still owns it.
		expect(store.listCheckpoints()).toHaveLength(1);
		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("releases the shell begin snapshot when end runs after revocation", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "sh.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		await recorder.beginShellCapture(work, ctx("t1", "c1"));
		await revoke();
		await writeFile(file, "v1", "utf8");
		await recorder.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		// Journaling stayed suppressed...
		expect(store.listCheckpoints()).toHaveLength(0);
		// ...but the begin snapshot was released, so a later end is a no-op
		// rather than a diff against a baseline that outlived the run.
		await recorder.endShellCapture(ctx("t1", "c1"));
		expect(shellBeginCount(store)).toBe(0);
	});

	it("does not attribute a revoked command's writes to the next command", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "sh.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		await recorder.beginShellCapture(work, ctx("t1", "c1"));
		await revoke();
		await writeFile(file, "v1", "utf8");
		await recorder.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		startTurn(bus, "t2");
		const foreground = store.scopedToTurn("t2");
		await foreground.beginShellCapture(work, ctx("t2", "c2"));
		await foreground.endShellCapture(ctx("t2", "c2"));
		endTurn(bus, "t2");

		expect(store.listCheckpoints()).toHaveLength(0);
		expect(await readFile(file, "utf8")).toBe("v1");
	});

	it("rejects a revoked requireRevertible capture before any write happens", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		revoke();

		await expect(
			recorder.recordPreImage(file, ctx("t1", "c1"), {
				tool: "ApplyPatch",
				requireRevertible: true,
			}),
		).rejects.toThrow(/rolled back/);
	});

	it("drops a capture that was in flight when it was revoked", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		// Revocation lands while the capture's file I/O is still pending.
		const capture = recorder.recordPreImage(file, ctx("t1", "c1"), {
			tool: "Edit",
		});
		revoke();
		await capture;
		await writeFile(file, "v1", "utf8");
		await recorder.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toHaveLength(0);
	});

	it("rejects an in-flight requireRevertible capture once revoked", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		const capture = recorder.recordPreImage(file, ctx("t1", "c1"), {
			tool: "ApplyPatch",
			requireRevertible: true,
		});
		revoke();

		await expect(capture).rejects.toThrow(/rolled back/);
		expect(store.listCheckpoints()).toHaveLength(0);
	});

	it("drops a capture revoked while its journal flush was pending", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		// Revocation lands after the last in-capture check, while the journal
		// flush is still in flight: the pre-image is already durable but the
		// post-image will be suppressed.
		let checks = 0;
		const racing = {
			...ctx("t1", "c1"),
			mayJournal: () => {
				if (++checks === 2) revoke();
				return true;
			},
		};
		await recorder.recordPreImage(file, racing, { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await recorder.recordPostImage(file, racing, Buffer.from("v1"));
		endTurn(bus, "t1");

		// The background run's write must not be revertible through the
		// foreground turn's checkpoint.
		expect(store.listCheckpoints()).toHaveLength(0);
		expect(store.undoTarget()).toBeNull();
	});

	it("rejects a requireRevertible capture revoked during its flush", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		let checks = 0;
		const racing = {
			...ctx("t1", "c1"),
			mayJournal: () => {
				if (++checks === 2) revoke();
				return true;
			},
		};

		await expect(
			recorder.recordPreImage(file, racing, {
				tool: "ApplyPatch",
				requireRevertible: true,
			}),
		).rejects.toThrow(/rolled back/);
		endTurn(bus, "t1");
		expect(store.listCheckpoints()).toHaveLength(0);
	});

	it("revokes recorders a nested run re-scoped from it", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.txt");
		await writeFile(file, "v0", "utf8");

		startTurn(bus, "t1");
		const { recorder, revoke } = revocableRecorder(store.scopedToTurn("t1"));
		const nested = recorder.scopedToTurn("subagent-turn");
		revoke();
		await nested.recordPreImage(file, ctx("t1", "c1"), { tool: "Edit" });
		await writeFile(file, "v1", "utf8");
		await nested.recordPostImage(file, ctx("t1", "c1"), Buffer.from("v1"));
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toHaveLength(0);
	});
});
