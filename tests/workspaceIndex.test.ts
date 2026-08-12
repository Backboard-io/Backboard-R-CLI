import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { BlobStore } from "../src/core/checkpoints/blobStore.ts";
import { CheckpointStore } from "../src/core/checkpoints/CheckpointStore.ts";
import {
	MAX_INDEX_FILES,
	WorkspaceIndex,
} from "../src/core/checkpoints/workspaceIndex.ts";
import type { SessionPaths } from "../src/core/session/SessionStore.ts";

let root: string;
let work: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "wsidx-test-"));
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
		checkpointObjects: join(checkpoints, "objects"),
		pendingUndo: join(root, "pending-undo.json"),
	};
}

function makeStore() {
	const bus = new EventBus();
	const store = new CheckpointStore(sessionPaths(), bus);
	return { bus, store };
}

function startTurn(bus: EventBus, turnId: string, label = "shell turn"): void {
	bus.emit({ type: "user:message", text: label });
	bus.emit({ type: "turn:start", turnId });
}

function endTurn(bus: EventBus, turnId: string): void {
	bus.emit({ type: "turn:end", turnId, status: "completed", durationMs: 1 });
}

const ctx = (turnId: string, toolCallId: string) => ({ turnId, toolCallId });

async function undoLatest(store: CheckpointStore) {
	const target = store.undoTarget();
	if (!target) throw new Error("expected an undo target");
	return store.restore(await store.planRestore(target), {
		skipDiverged: false,
	});
}

/** BlobStore that counts content stores, to observe hash-cache reuse. */
class CountingBlobStore extends BlobStore {
	puts = 0;
	override async put(content: Uint8Array): Promise<string> {
		this.puts += 1;
		return super.put(content);
	}
}

describe("WorkspaceIndex", () => {
	it("reuses the cached hash when size and mtime are unchanged", async () => {
		const blobs = new CountingBlobStore(join(root, "objects"));
		const index = new WorkspaceIndex(work);
		await writeFile(join(work, "a.txt"), "aaa", "utf8");
		await writeFile(join(work, "b.txt"), "bbb", "utf8");

		const first = await index.refresh(blobs);
		expect(first?.size).toBe(2);
		expect(blobs.puts).toBe(2);

		// Nothing changed: no re-read, no re-store.
		await index.refresh(blobs);
		expect(blobs.puts).toBe(2);

		// One file changed: exactly one new store.
		await writeFile(join(work, "a.txt"), "aaa2", "utf8");
		const third = await index.refresh(blobs);
		expect(blobs.puts).toBe(3);
		expect(third?.size).toBe(2);
	});

	it("detects a same-size rewrite landing in the same mtime tick (racy)", async () => {
		const { stat, utimes } = await import("node:fs/promises");
		const blobs = new CountingBlobStore(join(root, "objects"));
		const index = new WorkspaceIndex(work);
		const file = join(work, "racy.txt");
		await writeFile(file, "a0", "utf8");
		const before = await index.refresh(blobs);
		if (!before) throw new Error("expected a snapshot");

		// Same-size rewrite with mtime pinned to the cached stat — exactly the
		// coarse-timestamp race the (size, mtimeMs) cache cannot see.
		const st = await stat(file);
		await writeFile(file, "a1", "utf8");
		await utimes(file, st.atime, st.mtime);

		const after = await index.refresh(blobs);
		if (!after) throw new Error("expected a snapshot");
		const diff = index.diff(before, after);
		expect(diff.modified.map((entry) => entry.path)).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("a1");
	});

	it("ignores deny-listed directories and symlinks", async () => {
		const blobs = new BlobStore(join(root, "objects"));
		const index = new WorkspaceIndex(work);
		await writeFile(join(work, "kept.txt"), "kept", "utf8");
		for (const dir of ["node_modules", ".git", "dist", "__pycache__"]) {
			await mkdir(join(work, dir), { recursive: true });
			await writeFile(join(work, dir, "ignored.txt"), "ignored", "utf8");
		}
		const { symlink } = await import("node:fs/promises");
		await symlink(join(work, "kept.txt"), join(work, "link.txt"));

		const snapshot = await index.refresh(blobs);
		expect(snapshot).not.toBeNull();
		expect(
			[...(snapshot ?? new Map()).values()].map((entry) => entry.path),
		).toEqual([join(work, "kept.txt")]);
	});

	it("disables itself when the file cap is exceeded", async () => {
		const blobs = new BlobStore(join(root, "objects"));
		const index = new WorkspaceIndex(work);
		const perDir = 500;
		for (let dir = 0; dir * perDir <= MAX_INDEX_FILES; dir++) {
			const dirPath = join(work, `d${dir}`);
			await mkdir(dirPath);
			await Promise.all(
				Array.from({ length: perDir }, (_, i) =>
					writeFile(join(dirPath, `f${i}`), ""),
				),
			);
		}

		expect(await index.refresh(blobs)).toBeNull();
		expect(index.disabled).toMatch(/file cap/);
		// Once disabled, refresh stays a no-op.
		expect(await index.refresh(blobs)).toBeNull();
	}, 60_000);

	it("diffs created, modified and deleted paths", async () => {
		const blobs = new BlobStore(join(root, "objects"));
		const index = new WorkspaceIndex(work);
		await writeFile(join(work, "mod.txt"), "v0", "utf8");
		await writeFile(join(work, "gone.txt"), "bye", "utf8");
		const before = await index.refresh(blobs);
		if (!before) throw new Error("expected a snapshot");

		await writeFile(join(work, "mod.txt"), "v1", "utf8");
		await unlink(join(work, "gone.txt"));
		await writeFile(join(work, "new.txt"), "hi", "utf8");
		const after = await index.refresh(blobs);
		if (!after) throw new Error("expected a snapshot");

		const diff = index.diff(before, after);
		expect(diff.created.map((entry) => entry.path)).toEqual([
			join(work, "new.txt"),
		]);
		expect(diff.created[0]?.before).toBeNull();
		expect(diff.modified.map((entry) => entry.path)).toEqual([
			join(work, "mod.txt"),
		]);
		expect(diff.modified[0]?.before?.hash).toBeDefined();
		expect(diff.deleted.map((entry) => entry.path)).toEqual([
			join(work, "gone.txt"),
		]);
		expect(diff.deleted[0]?.afterHash).toBeNull();
	});
});

describe("CheckpointStore shell capture", () => {
	it("undoes a shell-created file by deleting it", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "made-by-shell.txt");

		startTurn(bus, "t1");
		await store.beginShellCapture(work, ctx("t1", "c1"));
		await writeFile(file, "from a shell command", "utf8");
		await store.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.added).toEqual([file]);

		const result = await undoLatest(store);
		expect(result.deleted).toEqual([file]);
		expect(existsSync(file)).toBe(false);
	});

	it("restores a shell-modified file byte-exact", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "f.bin");
		const original = Buffer.concat([
			Buffer.from("line\r\n", "latin1"),
			Buffer.from([0x00, 0xff, 0x80]),
		]);
		await writeFile(file, original);

		startTurn(bus, "t1");
		await store.beginShellCapture(work, ctx("t1", "c1"));
		await writeFile(file, "clobbered by shell", "utf8");
		await store.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		await undoLatest(store);
		expect((await readFile(file)).equals(original)).toBe(true);
	});

	it("recreates a shell-deleted file", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "victim.txt");
		await writeFile(file, "precious", "utf8");

		startTurn(bus, "t1");
		await store.beginShellCapture(work, ctx("t1", "c1"));
		await unlink(file);
		await store.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints[0]?.removed).toEqual([file]);

		await undoLatest(store);
		expect(await readFile(file, "utf8")).toBe("precious");
	});

	it("does not double-journal unchanged files across sequential commands", async () => {
		const { bus, store } = makeStore();
		const fileA = join(work, "a.txt");
		const fileB = join(work, "b.txt");
		await writeFile(fileA, "a0", "utf8");

		startTurn(bus, "t1");
		// Command 1 changes only a.txt.
		await store.beginShellCapture(work, ctx("t1", "c1"));
		await writeFile(fileA, "a1", "utf8");
		await store.endShellCapture(ctx("t1", "c1"));
		// Command 2 changes only b.txt: a.txt must not be re-reported.
		await store.beginShellCapture(work, ctx("t1", "c2"));
		await writeFile(fileB, "b1", "utf8");
		await store.endShellCapture(ctx("t1", "c2"));
		endTurn(bus, "t1");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.files.sort()).toEqual([fileA, fileB].sort());
		expect(checkpoints[0]?.modified).toEqual([fileA]);
		expect(checkpoints[0]?.added).toEqual([fileB]);

		await undoLatest(store);
		expect(await readFile(fileA, "utf8")).toBe("a0");
		expect(existsSync(fileB)).toBe(false);
	});

	it("captures nothing and stays silent when a command changes nothing", async () => {
		const { bus, store } = makeStore();
		await writeFile(join(work, "a.txt"), "a0", "utf8");

		startTurn(bus, "t1");
		await store.beginShellCapture(work, ctx("t1", "c1"));
		await store.endShellCapture(ctx("t1", "c1"));
		endTurn(bus, "t1");

		expect(store.listCheckpoints()).toEqual([]);
		expect(store.captureWarning()).toBeNull();
	});

	it("folds shell changes into the parent turn via scopedToTurn", async () => {
		const { bus, store } = makeStore();
		const file = join(work, "sub.txt");

		startTurn(bus, "parent");
		const recorder = store.scopedToTurn("parent");
		await recorder.beginShellCapture(work, ctx("sub-turn", "c1"));
		await writeFile(file, "sub agent shell", "utf8");
		await recorder.endShellCapture(ctx("sub-turn", "c1"));
		endTurn(bus, "parent");

		const checkpoints = store.listCheckpoints();
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.id).toBe("parent");
		expect(checkpoints[0]?.added).toEqual([file]);
	});
});

describe("lazy warm-up (hash-only) refresh", () => {
	it("writes no blobs on a non-storing refresh, upgrades on a storing one", async () => {
		await writeFile(join(work, "a.txt"), "alpha");
		await writeFile(join(work, "b.txt"), "beta");
		const objects = join(root, "objects");
		const blobs = new CountingBlobStore(objects);
		const index = new WorkspaceIndex(work);

		const warm = await index.refresh(blobs, { storeBlobs: false });
		expect(warm?.size).toBe(2);
		expect(blobs.puts).toBe(0);
		expect(existsSync(objects)).toBe(false);

		// A storing refresh re-reads unstored entries even though (size, mtime)
		// is unchanged — their bytes must become restorable pre-images.
		const stored = await index.refresh(blobs, { storeBlobs: true });
		expect(stored?.size).toBe(2);
		expect(blobs.puts).toBe(2);
		for (const entry of stored?.values() ?? []) {
			expect(entry.stored).toBe(true);
			expect(await blobs.has(entry.hash ?? "")).toBe(true);
		}
	});

	it("warm-up then command: shell change is still fully undoable", async () => {
		const file = join(work, "data.txt");
		await writeFile(file, "v0");
		const { bus, store } = makeStore();

		store.warmShellCapture(work);
		startTurn(bus, "t1");
		// Queued behind the warm-up; upgrades the hash-only entries.
		await store.beginShellCapture(work, ctx("t1", "tc1"));
		await writeFile(file, "CHANGED BY SHELL");
		await store.endShellCapture(ctx("t1", "tc1"));
		endTurn(bus, "t1");

		const result = await undoLatest(store);
		expect(result.restored).toEqual([file]);
		expect(await readFile(file, "utf8")).toBe("v0");
	});

	it("keeps per-tool-call baselines for interleaved begin/end pairs", async () => {
		const first = join(work, "first.txt");
		const second = join(work, "second.txt");
		const { bus, store } = makeStore();
		startTurn(bus, "t1");

		await store.beginShellCapture(work, ctx("t1", "tc-a"));
		await writeFile(first, "made by a");
		await store.beginShellCapture(work, ctx("t1", "tc-b"));
		await writeFile(second, "made by b");
		// Ends in reverse order: each diff must run against its own baseline.
		await store.endShellCapture(ctx("t1", "tc-b"));
		await store.endShellCapture(ctx("t1", "tc-a"));
		endTurn(bus, "t1");

		const [checkpoint] = store.listCheckpoints();
		// Both files land in the turn checkpoint exactly once.
		expect(checkpoint?.added.sort()).toEqual([first, second]);
	});
});
