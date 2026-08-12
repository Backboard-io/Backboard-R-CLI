import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CheckpointManager } from "../src/core/checkpoints/CheckpointManager.ts";
import { CheckpointStore } from "../src/core/checkpoints/CheckpointStore.ts";
import { SessionStore } from "../src/core/session/SessionStore.ts";

async function createSession(
	cwd: string,
	sessionId: string,
): Promise<SessionStore> {
	const store = new SessionStore(sessionId, cwd);
	await store.init({
		sessionId,
		createdAt: new Date().toISOString(),
		cwd,
		model: "anthropic/test",
		profile: "coding",
	});
	return store;
}

describe("CheckpointManager", () => {
	it("switches checkpoint history with the resumed local session", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "checkpoint-manager-"));
		const first = await createSession(cwd, "sess_first");
		const second = await createSession(cwd, "sess_second");
		const bus = new EventBus();
		const manager = new CheckpointManager(bus, first.paths, cwd);
		const file = path.join(cwd, "file.txt");
		await writeFile(file, "before", "utf8");

		bus.emit({ type: "user:message", text: "change file" });
		bus.emit({ type: "turn:start", turnId: "turn_one" });
		await manager.recordPreImage(file, {
			turnId: "turn_one",
			toolCallId: "tool_one",
		});
		await writeFile(file, "after", "utf8");
		await manager.recordPostImage(file, {
			turnId: "turn_one",
			toolCallId: "tool_one",
		});
		bus.emit({
			type: "turn:end",
			turnId: "turn_one",
			status: "completed",
			durationMs: 1,
		});
		await manager.flush();
		expect(manager.listCheckpoints()).toHaveLength(1);

		await manager.activateRoot(second.paths.root);
		expect(manager.listCheckpoints()).toEqual([]);

		await manager.activateRoot(first.paths.root);
		expect(manager.listCheckpoints()).toHaveLength(1);
		const plan = await manager.planRestore("turn_one");
		await manager.restore(plan, { skipDiverged: false });
		expect(await readFile(file, "utf8")).toBe("before");
		await manager.dispose();
	});

	it("keeps the current store active when replacement recovery fails", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "checkpoint-manager-"));
		const first = await createSession(cwd, "sess_first");
		const second = await createSession(cwd, "sess_second");
		const bus = new EventBus();
		const manager = new CheckpointManager(bus, first.paths, cwd);
		const recover = CheckpointStore.recoverAbandonedRestore;
		CheckpointStore.recoverAbandonedRestore = async () => {
			throw new Error("recovery failed");
		};
		try {
			await expect(manager.activateRoot(second.paths.root)).rejects.toThrow(
				"recovery failed",
			);
		} finally {
			CheckpointStore.recoverAbandonedRestore = recover;
		}

		const file = path.join(cwd, "still-active.txt");
		await writeFile(file, "before", "utf8");
		bus.emit({ type: "user:message", text: "change file" });
		bus.emit({ type: "turn:start", turnId: "turn_after_failure" });
		await manager.recordPreImage(file, {
			turnId: "turn_after_failure",
			toolCallId: "tool_after_failure",
		});
		await writeFile(file, "after", "utf8");
		await manager.recordPostImage(file, {
			turnId: "turn_after_failure",
			toolCallId: "tool_after_failure",
		});
		bus.emit({
			type: "turn:end",
			turnId: "turn_after_failure",
			status: "completed",
			durationMs: 1,
		});
		await manager.flush();

		expect(manager.activeRoot).toBe(first.paths.root);
		expect(manager.listCheckpoints()).toHaveLength(1);
		await manager.dispose();
	});

	it("routes an existing scoped recorder through the newly active store", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "checkpoint-manager-"));
		const first = await createSession(cwd, "sess_first");
		const second = await createSession(cwd, "sess_second");
		const bus = new EventBus();
		const manager = new CheckpointManager(bus, first.paths, cwd);
		const scoped = manager.scopedToTurn("root_turn");
		await manager.activateRoot(second.paths.root);
		const file = path.join(cwd, "scoped.txt");
		await writeFile(file, "before", "utf8");

		bus.emit({ type: "user:message", text: "scoped edit" });
		bus.emit({ type: "turn:start", turnId: "root_turn" });
		await scoped.recordPreImage(file, {
			turnId: "child_turn",
			toolCallId: "child_tool",
		});
		await writeFile(file, "after", "utf8");
		await scoped.recordPostImage(file, {
			turnId: "child_turn",
			toolCallId: "child_tool",
		});
		bus.emit({
			type: "turn:end",
			turnId: "root_turn",
			status: "completed",
			durationMs: 1,
		});
		await manager.flush();

		expect(manager.activeRoot).toBe(second.paths.root);
		expect(manager.listCheckpoints()).toHaveLength(1);
		await manager.dispose();
	});
});
