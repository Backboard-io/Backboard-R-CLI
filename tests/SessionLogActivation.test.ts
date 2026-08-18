import { describe, expect, it } from "bun:test";
import {
	type ActivatableSessionLog,
	activateSessionLogs,
} from "../src/core/session/SessionLogActivation.ts";

describe("activateSessionLogs", () => {
	it("activates both logs in order", async () => {
		const calls: string[] = [];
		const client = recordingLog("client", calls);
		const server = recordingLog("server", calls);
		await activateSessionLogs({
			clientLog: client,
			serverLog: server,
			next: nextSession(),
			previous: previousSession(),
		});
		expect(calls).toEqual([
			"client:sess_next:/next/client",
			"server:sess_next:/next/server",
		]);
	});

	it("restores both logs when one activation fails", async () => {
		const calls: string[] = [];
		const client = recordingLog("client", calls);
		const server = recordingLog("server", calls, "sess_next");
		await expect(
			activateSessionLogs({
				clientLog: client,
				serverLog: server,
				next: nextSession(),
				previous: previousSession(),
			}),
		).rejects.toThrow("server failed");
		expect(calls).toEqual([
			"client:sess_next:/next/client",
			"server:sess_next:/next/server",
			"client:sess_previous:/previous/client",
			"server:sess_previous:/previous/server",
		]);
	});

	it("reports activation and rollback failures together", async () => {
		const calls: string[] = [];
		const client = recordingLog("client", calls, "sess_previous");
		const server = recordingLog("server", calls, "sess_next");
		await expect(
			activateSessionLogs({
				clientLog: client,
				serverLog: server,
				next: nextSession(),
				previous: previousSession(),
			}),
		).rejects.toBeInstanceOf(AggregateError);
	});
});

function recordingLog(
	name: string,
	calls: string[],
	failSessionId?: string,
): ActivatableSessionLog {
	return {
		async activate(sessionId, filePath) {
			calls.push(`${name}:${sessionId}:${filePath}`);
			if (sessionId === failSessionId) {
				throw new Error(`${name} failed`);
			}
		},
	};
}

function nextSession() {
	return {
		sessionId: "sess_next",
		clientLog: "/next/client",
		serverLog: "/next/server",
	};
}

function previousSession() {
	return {
		sessionId: "sess_previous",
		clientLog: "/previous/client",
		serverLog: "/previous/server",
	};
}
