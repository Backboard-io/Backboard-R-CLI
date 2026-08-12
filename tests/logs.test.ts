import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ClientEventLog } from "../src/core/session/ClientEventLog.ts";
import { ServerEventLog } from "../src/core/session/ServerEventLog.ts";
import { SessionStore } from "../src/core/session/SessionStore.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("SessionStore + logs", () => {
	it("writes session meta", async () => {
		const store = new SessionStore("sess_x", dir);
		await store.init({
			sessionId: "sess_x",
			createdAt: new Date().toISOString(),
			cwd: dir,
			model: "openai/gpt-5.5",
			profile: "coding",
		});
		const meta = JSON.parse(await readFile(store.paths.meta, "utf8"));
		expect(meta.sessionId).toBe("sess_x");
		expect(meta.model).toBe("openai/gpt-5.5");
	});

	it("client log records every event with required fields", async () => {
		const store = new SessionStore("sess_y", dir);
		await store.init({
			sessionId: "sess_y",
			createdAt: new Date().toISOString(),
			cwd: dir,
			model: "m",
			profile: "coding",
		});
		const bus = new EventBus();
		const log = new ClientEventLog("sess_y", store.paths.clientLog);
		log.attach(bus);

		bus.emit({ type: "user:message", text: "hi" });
		bus.emit({ type: "turn:start", turnId: "t1" });
		await log.flush();

		const records = await readJsonl(store.paths.clientLog);
		expect(records.length).toBe(2);
		for (const r of records) {
			expect(typeof r.timestamp).toBe("string");
			expect(r.session_id).toBe("sess_y");
			expect(typeof r.sequence).toBe("number");
			expect(r.source).toBe("client");
		}
		expect(records[0]?.sequence).toBe(0);
		expect(records[1]?.sequence).toBe(1);
	});

	it("writes log files with private permissions", async () => {
		const store = new SessionStore("sess_private", dir);
		await store.init({
			sessionId: "sess_private",
			createdAt: new Date().toISOString(),
			cwd: dir,
			model: "m",
			profile: "coding",
		});
		const bus = new EventBus();
		const log = new ClientEventLog("sess_private", store.paths.clientLog);
		log.attach(bus);

		bus.emit({ type: "user:message", text: "private prompt" });
		await log.flush();

		if (process.platform !== "win32") {
			expect((await stat(store.paths.clientLog)).mode & 0o777).toBe(0o600);
		}
	});

	it("server log redacts secret headers", async () => {
		const store = new SessionStore("sess_z", dir);
		await store.init({
			sessionId: "sess_z",
			createdAt: new Date().toISOString(),
			cwd: dir,
			model: "m",
			profile: "coding",
		});
		const log = new ServerEventLog("sess_z", store.paths.serverLog);
		log.request({
			endpoint: "/threads/messages",
			method: "POST",
			headers: {
				"X-API-Key": "super-secret",
				"Content-Type": "application/json",
			},
			body: { content: "hello" },
		});
		await log.flush();

		const records = await readJsonl(store.paths.serverLog);
		const headers = records[0]?.headers as Record<string, string>;
		expect(headers["X-API-Key"]).toBe("<redacted>");
		expect(headers["Content-Type"]).toBe("application/json");
	});
});
