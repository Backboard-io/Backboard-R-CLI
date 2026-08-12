import { describe, expect, it } from "bun:test";
import { BrowserHarnessSession } from "../src/core/browser/BrowserHarnessSession.ts";
import { BrowserSessionManager } from "../src/core/browser/BrowserSessionManager.ts";

class FakeSocket extends EventTarget {
	readyState: number = WebSocket.CONNECTING;
	readonly sent: string[] = [];

	send(payload: string): void {
		this.sent.push(payload);
	}

	respond(body: unknown): void {
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(body) }),
		);
	}

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	open(): void {
		this.readyState = WebSocket.OPEN;
		this.dispatchEvent(new Event("open"));
	}
}

describe("BrowserSessionManager", () => {
	it("fails explicit CDP config instead of launching a fallback browser", async () => {
		let spawned = false;
		const manager = new BrowserSessionManager({
			env: { browserCdpUrl: "http://127.0.0.1:9" },
			fetch: (async () =>
				new Response("missing", { status: 404 })) as unknown as typeof fetch,
			spawn: (() => {
				spawned = true;
				throw new Error("should not launch");
			}) as unknown as typeof Bun.spawn,
		});

		await expect(
			manager.getPlatform(new AbortController().signal),
		).rejects.toThrow("Configured Browser DevTools endpoint is not usable.");
		expect(spawned).toBe(false);
	});

	it("cleans up a launched browser when startup is aborted", async () => {
		let killed = false;
		const manager = new BrowserSessionManager({
			env: { browserPath: "/fake/chrome" },
			executable: {
				canExecute: async (path) => path === "/fake/chrome",
				platform: "linux",
				pathDirs: [],
			},
			fetch: (async () =>
				new Response("missing", { status: 404 })) as unknown as typeof fetch,
			spawn: (() =>
				({
					kill: () => {
						killed = true;
					},
					exited: Promise.resolve(0),
				}) as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
		});
		const controller = new AbortController();
		controller.abort();

		await expect(manager.getPlatform(controller.signal)).rejects.toThrow(
			"aborted",
		);
		expect(killed).toBe(true);
	});
});

describe("BrowserHarnessSession", () => {
	it("closes the CDP socket and rejects pending calls", async () => {
		const socket = new FakeSocket();
		const session = new BrowserHarnessSession({
			webSocketUrl: "ws://browser.test/devtools",
			webSocketFactory: () => socket as unknown as WebSocket,
		});

		const connected = session.connect();
		socket.open();
		await connected;

		const pending = session.call("Browser.getVersion");
		await Promise.resolve();
		expect(socket.sent).toHaveLength(1);

		session.close();

		await expect(pending).rejects.toThrow("Browser CDP socket closed");
		expect(socket.readyState).toBe(WebSocket.CLOSED);
	});

	it("reattaches and retries page commands after a stale CDP session", async () => {
		const socket = new FakeSocket();
		const session = new BrowserHarnessSession({
			webSocketUrl: "ws://browser.test/devtools",
			webSocketFactory: () => socket as unknown as WebSocket,
			routePageCommands: true,
		});

		const connected = session.connect();
		socket.open();
		await connected;

		const pending = session.call("Page.captureScreenshot");
		await waitForSent(socket, 1);
		socket.respond({
			id: 1,
			result: { targetInfos: [{ targetId: "target_1", type: "page" }] },
		});
		await waitForSent(socket, 2);
		socket.respond({ id: 2, result: { sessionId: "session_old" } });
		await waitForSent(socket, 3);
		expect(JSON.parse(socket.sent[2] ?? "{}")).toMatchObject({
			method: "Page.captureScreenshot",
			sessionId: "session_old",
		});
		socket.respond({
			id: 3,
			error: { message: "Session with given id not found" },
		});

		await waitForSent(socket, 4);
		socket.respond({
			id: 4,
			result: { targetInfos: [{ targetId: "target_1", type: "page" }] },
		});
		await waitForSent(socket, 5);
		socket.respond({ id: 5, result: { sessionId: "session_new" } });
		await waitForSent(socket, 6);
		expect(JSON.parse(socket.sent[5] ?? "{}")).toMatchObject({
			method: "Page.captureScreenshot",
			sessionId: "session_new",
		});
		socket.respond({ id: 6, result: { data: "ok" } });

		await expect(pending).resolves.toEqual({ data: "ok" });
	});
});

async function waitForSent(socket: FakeSocket, count: number): Promise<void> {
	for (let i = 0; i < 10; i++) {
		if (socket.sent.length >= count) return;
		await Promise.resolve();
	}
	throw new Error(`Expected ${count} sent CDP messages.`);
}
