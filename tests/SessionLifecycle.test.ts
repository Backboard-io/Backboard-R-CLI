import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { CheckpointManager } from "../src/core/checkpoints/CheckpointManager.ts";
import { SessionLifecycle } from "../src/core/session/SessionLifecycle.ts";
import { SessionStore } from "../src/core/session/SessionStore.ts";

describe("SessionLifecycle", () => {
	it("allows only one live process lifecycle to own a session root", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "session-lifecycle-"));
		const store = new SessionStore("sess_shared", cwd);
		await store.init({
			sessionId: "sess_shared",
			createdAt: new Date().toISOString(),
			cwd,
			model: "anthropic/test",
			profile: "coding",
		});
		const config = {
			cwd,
			modelString: "anthropic/test",
			profile: { name: "coding" },
		} as Config;
		const first = new SessionLifecycle(
			config,
			new CheckpointManager(new EventBus(), store.paths, cwd),
			store,
		);
		const second = new SessionLifecycle(
			config,
			new CheckpointManager(new EventBus(), store.paths, cwd),
			store,
		);
		await first.initialize();

		await expect(second.initialize()).rejects.toThrow(
			"Another CLI process may still be using it",
		);
		await first.dispose();
		await second.initialize();
		await second.dispose();
	});

	it("restores the previous checkpoint root when activation callbacks fail", async () => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "session-lifecycle-"));
		const initial = new SessionStore("sess_initial", cwd);
		const target = new SessionStore("sess_target", cwd);
		for (const store of [initial, target]) {
			await store.init({
				sessionId: store === initial ? "sess_initial" : "sess_target",
				createdAt: new Date().toISOString(),
				cwd,
				model: "anthropic/test",
				profile: "coding",
			});
		}
		const config = {
			cwd,
			modelString: "anthropic/test",
			profile: { name: "coding" },
		} as Config;
		const checkpoints = new CheckpointManager(
			new EventBus(),
			initial.paths,
			cwd,
		);
		const lifecycle = new SessionLifecycle(
			config,
			checkpoints,
			initial,
			async () => {
				throw new Error("log rotation failed");
			},
		);
		await lifecycle.initialize();

		await expect(lifecycle.resume("sess_target")).rejects.toThrow(
			"log rotation failed",
		);

		expect(lifecycle.current().sessionId).toBe("sess_initial");
		expect(checkpoints.activeRoot).toBe(initial.paths.root);
		await lifecycle.dispose();
		await checkpoints.dispose();
	});
});
