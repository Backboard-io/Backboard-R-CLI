import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import {
	BackboardError,
	BackboardTransportError,
} from "../src/providers/backboard/errors.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("BackboardClient streaming transport", () => {
	it("lists and fetches threads", async () => {
		const requestedUrls: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			requestedUrls.push(url);
			if (url.endsWith("/threads?limit=200&include_messages=false")) {
				return Response.json([{ thread_id: "thread_1", messages: [] }]);
			}
			return Response.json({ thread_id: "thread_1", messages: [] });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(client.listThreads()).resolves.toEqual([
			{ thread_id: "thread_1", messages: [] },
		]);
		await expect(client.getThread("thread/1")).resolves.toEqual({
			thread_id: "thread_1",
			messages: [],
		});
		expect(requestedUrls).toEqual([
			"https://api.example.test/threads?limit=200&include_messages=false",
			"https://api.example.test/threads/thread%2F1",
		]);
	});

	it("submits run-scoped tool outputs with continuation tools", async () => {
		let requestedUrl = "";
		let requestedBody: unknown;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedUrl = String(input);
			requestedBody = JSON.parse(String(init?.body));
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		for await (const _event of client.runToolOutputs({
			thread_id: "thread 1",
			run_id: "run/1",
			tool_outputs: [{ tool_call_id: "call_1", output: "ok" }],
			tools: [],
		})) {
			// no-op
		}

		expect(requestedUrl).toBe(
			"https://api.example.test/threads/thread%201/runs/run%2F1/submit-tool-outputs?stream=true",
		);
		expect(requestedBody).toEqual({
			tool_outputs: [{ tool_call_id: "call_1", output: "ok" }],
			tools: [],
			stream: true,
		});
	});

	it("wraps stream read failures with endpoint context", async () => {
		globalThis.fetch = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						throw new Error("The operation timed out.");
					},
				}),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		let thrown: unknown;
		try {
			for await (const _event of client.runToolOutputs({
				thread_id: "thread",
				tool_outputs: [],
			})) {
				// no-op
			}
		} catch (err) {
			thrown = err;
		}

		expect(thrown).toBeInstanceOf(BackboardTransportError);
		expect((thrown as Error).message).toContain(
			"Backboard stream failed for /threads/tool-outputs",
		);
		expect((thrown as Error).message).toContain("The operation timed out.");
	});
});

describe("BackboardClient attachment endpoints", () => {
	let testTmpDir: string;

	beforeAll(async () => {
		testTmpDir = await mkdtemp(join(tmpdir(), "backboard-client-test-"));
	});

	afterAll(async () => {
		await rm(testTmpDir, { recursive: true, force: true });
	});

	it("runMessage with attachment file paths posts multipart form data", async () => {
		const filePath = join(
			testTmpDir,
			`backboard-attachment-test-${Date.now()}.txt`,
		);
		await Bun.write(filePath, "hello attachment");

		let requestedUrl = "";
		let requestedMethod = "";
		let requestedHeaders: Headers | undefined;
		let requestedBody: FormData | undefined;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedUrl = String(input);
			requestedMethod = String(init?.method);
			requestedHeaders = new Headers(init?.headers);
			requestedBody = init?.body as FormData;
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		const events = [];
		for await (const event of client.runMessage(
			{
				content: "look at this",
				thread_id: "thr_1",
				tools: [],
				metadata: { backboard_workspace_id: "ws_1" },
			},
			{ attachmentFilePaths: [filePath] },
		)) {
			events.push(event);
		}

		expect(events).toEqual([]);
		expect(requestedUrl).toBe("https://api.example.test/threads/messages");
		expect(requestedMethod).toBe("POST");
		expect(requestedHeaders?.get("X-API-Key")).toBe("test");
		expect(requestedHeaders?.has("Content-Type")).toBe(false);
		expect(requestedBody).toBeInstanceOf(FormData);
		expect(requestedBody?.get("content")).toBe("look at this");
		expect(requestedBody?.get("thread_id")).toBe("thr_1");
		expect(requestedBody?.get("stream")).toBe("true");
		expect(requestedBody?.get("tools")).toBe("[]");
		expect(requestedBody?.get("metadata")).toBe(
			JSON.stringify({ backboard_workspace_id: "ws_1" }),
		);
		const uploadedFile = requestedBody?.get("files") as File;
		expect(await uploadedFile.text()).toBe("hello attachment");
		// Bun.file()-backed FormData entries report the source path via .name
		// instead of the append()-time filename override, so check the filename
		// that is actually serialized onto the wire instead.
		const serializedBody = await new Request("http://localhost", {
			method: "POST",
			body: requestedBody,
		}).text();
		expect(serializedBody).toContain(`filename="${basename(filePath)}"`);
	});

	it("runMessage without attachments keeps the JSON body", async () => {
		let requestedHeaders: Headers | undefined;
		let requestedBody: string | undefined;
		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			requestedHeaders = new Headers(init?.headers);
			requestedBody = init?.body as string;
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		for await (const _event of client.runMessage({ content: "hi" })) {
			// drain
		}

		expect(requestedHeaders?.get("Content-Type")).toBe("application/json");
		expect(JSON.parse(requestedBody ?? "")).toEqual({
			content: "hi",
			stream: true,
		});
	});

	it("throws BackboardError on non-2xx", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ detail: "nope" }), {
				status: 400,
			})) as unknown as typeof fetch;

		const client = new BackboardClient({
			apiKey: "test",
			apiUrl: "https://api.example.test",
		});

		await expect(
			client.createAssistant({ name: "a", system_prompt: "s", tools: [] }),
		).rejects.toBeInstanceOf(BackboardError);
	});
});
