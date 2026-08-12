import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ClientEventLog } from "../src/core/session/ClientEventLog.ts";
import { JsonlWriter } from "../src/core/session/JsonlWriter.ts";
import { ServerEventLog } from "../src/core/session/ServerEventLog.ts";

describe("switchable session event logs", () => {
	it("writes client and server events to the active session files", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "session-logs-"));
		const firstClient = path.join(root, "first-client.jsonl");
		const secondClient = path.join(root, "second-client.jsonl");
		const firstServer = path.join(root, "first-server.jsonl");
		const secondServer = path.join(root, "second-server.jsonl");
		const bus = new EventBus();
		const client = new ClientEventLog("sess_first", firstClient);
		const server = new ServerEventLog("sess_first", firstServer);
		client.attach(bus);

		bus.emit({ type: "system:warning", message: "first" });
		server.request({
			endpoint: "/first",
			method: "GET",
			headers: {},
			body: null,
		});
		await Promise.all([
			client.activate("sess_second", secondClient),
			server.activate("sess_second", secondServer),
		]);
		bus.emit({ type: "system:warning", message: "second" });
		server.request({
			endpoint: "/second",
			method: "GET",
			headers: {},
			body: null,
		});
		await Promise.all([client.flush(), server.flush()]);

		expect(await readFile(firstClient, "utf8")).toContain('"sess_first"');
		expect(await readFile(firstClient, "utf8")).not.toContain('"second"');
		expect(await readFile(secondClient, "utf8")).toContain('"sess_second"');
		expect(await readFile(secondClient, "utf8")).toContain('"second"');
		expect(await readFile(firstServer, "utf8")).toContain('"/first"');
		expect(await readFile(secondServer, "utf8")).toContain('"/second"');
		client.detach();
	});

	it("continues sequence numbers in an existing resumed session log", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "session-logs-"));
		const initialClient = path.join(root, "initial-client.jsonl");
		const resumedClient = path.join(root, "resumed-client.jsonl");
		const initialServer = path.join(root, "initial-server.jsonl");
		const resumedServer = path.join(root, "resumed-server.jsonl");
		await writeFile(
			resumedClient,
			`{"sequence":7}\n${"corrupt-tail".repeat(7_000)}`,
			"utf8",
		);
		await writeFile(resumedServer, '{"sequence":4}\n{corrupt', "utf8");
		const bus = new EventBus();
		const client = new ClientEventLog("sess_initial", initialClient);
		const server = new ServerEventLog("sess_initial", initialServer);
		client.attach(bus);

		await Promise.all([
			client.activate("sess_resumed", resumedClient),
			server.activate("sess_resumed", resumedServer),
		]);
		bus.emit({ type: "system:warning", message: "continued" });
		server.request({
			endpoint: "/continued",
			method: "GET",
			headers: {},
			body: null,
		});
		await Promise.all([client.flush(), server.flush()]);

		const clientContent = await readFile(resumedClient, "utf8");
		const serverContent = await readFile(resumedServer, "utf8");
		expect(clientContent).toContain('corrupt-tail\n{"timestamp"');
		expect(serverContent).toContain('{corrupt\n{"timestamp"');
		expect(clientContent).toContain('"sequence":8');
		expect(serverContent).toContain('"sequence":5');
		client.detach();
	});

	it("continues after an oversized final JSONL record", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "session-logs-"));
		const initialClient = path.join(root, "initial-client.jsonl");
		const resumedClient = path.join(root, "resumed-client.jsonl");
		await writeFile(
			resumedClient,
			`${JSON.stringify({ sequence: 41, payload: "x".repeat(2 * 1024 * 1024) })}\n`,
			"utf8",
		);
		const bus = new EventBus();
		const client = new ClientEventLog("sess_initial", initialClient);
		client.attach(bus);

		await client.activate("sess_resumed", resumedClient);
		bus.emit({ type: "system:warning", message: "continued" });
		await client.flush();

		expect(await readFile(resumedClient, "utf8")).toContain('"sequence":42');
		client.detach();
	});

	it("handles an initial boundary failure before flush observes it", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "session-logs-"));
		let unhandled: unknown;
		const onUnhandled = (reason: unknown) => {
			unhandled = reason;
		};
		process.on("unhandledRejection", onUnhandled);
		const writer = new JsonlWriter(root);
		try {
			writer.write({ sequence: 0 });
			await Bun.sleep(20);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toBeUndefined();
		await expect(writer.flush()).rejects.toBeDefined();
	});

	it("queues records emitted during activation for the new log", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "session-logs-"));
		const firstClient = path.join(root, "first-client.jsonl");
		const secondClient = path.join(root, "second-client.jsonl");
		const firstServer = path.join(root, "first-server.jsonl");
		const secondServer = path.join(root, "second-server.jsonl");
		await writeFile(secondClient, `${"x".repeat(100_000)}\n`, "utf8");
		await writeFile(secondServer, `${"x".repeat(100_000)}\n`, "utf8");
		const bus = new EventBus();
		const client = new ClientEventLog("sess_first", firstClient);
		const server = new ServerEventLog("sess_first", firstServer);
		client.attach(bus);

		const clientActivation = client.activate("sess_second", secondClient);
		const serverActivation = server.activate("sess_second", secondServer);
		bus.emit({ type: "system:warning", message: "during activation" });
		server.request({
			endpoint: "/during-activation",
			method: "GET",
			headers: {},
			body: null,
		});
		await Promise.all([clientActivation, serverActivation]);
		await Promise.all([client.flush(), server.flush()]);

		expect(await readFile(secondClient, "utf8")).toContain(
			'"during activation"',
		);
		expect(await readFile(secondServer, "utf8")).toContain(
			'"/during-activation"',
		);
		expect(await readFile(firstClient, "utf8").catch(() => "")).not.toContain(
			"during activation",
		);
		expect(await readFile(firstServer, "utf8").catch(() => "")).not.toContain(
			"/during-activation",
		);
		client.detach();
	});
});
