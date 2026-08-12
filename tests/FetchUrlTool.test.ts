import { afterEach, describe, expect, it } from "bun:test";
import { FetchUrlTool } from "../src/tools/FetchUrlTool.tsx";
import { makeContext } from "./helpers.ts";

const originalFetch = globalThis.fetch;

describe("FetchUrlTool", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("blocks localhost before fetching", async () => {
		const tool = new FetchUrlTool();
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("nope");
		}) as unknown as typeof fetch;

		await expect(
			tool.execute(
				{ url: "http://127.0.0.1:9222/json" },
				makeContext(new AbortController().signal),
			),
		).rejects.toThrow("private networks");
		expect(called).toBe(false);
	});

	it("blocks private network addresses before fetching", async () => {
		const tool = new FetchUrlTool();
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("nope");
		}) as unknown as typeof fetch;

		await expect(
			tool.execute(
				{ url: "https://169.254.169.254/latest/meta-data/" },
				makeContext(new AbortController().signal),
			),
		).rejects.toThrow("private networks");
		expect(called).toBe(false);
	});

	it("blocks private network redirects", async () => {
		const tool = new FetchUrlTool();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(null, {
				status: 302,
				headers: { location: "http://127.0.0.1/admin" },
			});
		}) as unknown as typeof fetch;

		await expect(
			tool.execute(
				{ url: "https://93.184.216.34/" },
				makeContext(new AbortController().signal),
			),
		).rejects.toThrow("private networks");
		expect(calls).toBe(1);
	});

	it("blocks private IPv6 addresses before fetching", async () => {
		const tool = new FetchUrlTool();
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response("nope");
		}) as unknown as typeof fetch;

		await expect(
			tool.execute(
				{ url: "http://[::1]/" },
				makeContext(new AbortController().signal),
			),
		).rejects.toThrow("private networks");
		expect(called).toBe(false);
	});

	it("allows public http URLs", async () => {
		const tool = new FetchUrlTool();
		globalThis.fetch = (async () =>
			new Response("hello")) as unknown as typeof fetch;

		const result = await tool.execute(
			{ url: "https://93.184.216.34/" },
			makeContext(new AbortController().signal),
		);

		expect(result.data.text).toBe("hello");
	});
});
