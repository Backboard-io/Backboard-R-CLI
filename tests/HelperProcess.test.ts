import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperProcess } from "../src/core/platform/HelperProcess.ts";

const tempDirs: string[] = [];
const helpers: HelperProcess[] = [];

afterEach(async () => {
	await Promise.all(helpers.map((helper) => helper.dispose()));
	helpers.length = 0;
	await Promise.all(
		tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
	);
	tempDirs.length = 0;
});

/** A tiny JSON-lines echo server with a few scripted behaviours. */
const FAKE_HELPER = `
const lines = [];
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.op === "die") { process.stderr.write("fatal: asked to die"); process.exit(3); }
    if (req.op === "hang") continue;
    if (req.op === "fail") { process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: "nope" }) + "\\n"); continue; }
    if (req.op === "noise") { process.stdout.write("garbage line\\n"); }
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, echo: req, pid: process.pid }) + "\\n");
  }
});
`;

async function fakeHelper(
	options: { requestTimeoutMs?: number } = {},
): Promise<HelperProcess> {
	const dir = await mkdtemp(join(tmpdir(), "helper-test-"));
	tempDirs.push(dir);
	const script = join(dir, "helper.js");
	await writeFile(script, FAKE_HELPER);
	const helper = new HelperProcess({
		command: process.execPath,
		args: [script],
		label: "fake helper",
		requestTimeoutMs: options.requestTimeoutMs ?? 5000,
	});
	helpers.push(helper);
	return helper;
}

describe("HelperProcess", () => {
	it("round-trips requests by id and keeps one process warm", async () => {
		const helper = await fakeHelper();
		const a = await helper.request<{ echo: { op: string }; pid: number }>({
			op: "ping",
			x: 1,
		});
		const b = await helper.request<{ pid: number }>({ op: "ping" });
		expect(a.echo.op).toBe("ping");
		expect(a.pid).toBe(b.pid);
		expect(helper.isRunning).toBe(true);
	});

	it("answers concurrent requests independently", async () => {
		const helper = await fakeHelper();
		const results = await Promise.all(
			[1, 2, 3].map((n) =>
				helper.request<{ echo: { n: number } }>({ op: "ping", n }),
			),
		);
		expect(results.map((r) => r.echo.n)).toEqual([1, 2, 3]);
	});

	it("rejects failed responses with the helper's message", async () => {
		const helper = await fakeHelper();
		await expect(helper.request({ op: "fail" })).rejects.toThrow("nope");
	});

	it("ignores non-JSON stdout noise", async () => {
		const helper = await fakeHelper();
		const result = await helper.request<{ ok: boolean }>({ op: "noise" });
		expect(result.ok).toBe(true);
	});

	it("times out hung requests and honours abort signals", async () => {
		const helper = await fakeHelper({ requestTimeoutMs: 100 });
		await expect(helper.request({ op: "hang" })).rejects.toThrow(
			"within 100ms",
		);
		const controller = new AbortController();
		const pending = helper.request(
			{ op: "hang" },
			{ signal: controller.signal, timeoutMs: 5000 },
		);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
		const after = await helper.request<{ ok: boolean }>({ op: "ping" });
		expect(after.ok).toBe(true);
	});

	it("fails pending requests when the process dies, then respawns", async () => {
		const helper = await fakeHelper();
		const first = await helper.request<{ pid: number }>({ op: "ping" });
		await expect(helper.request({ op: "die" })).rejects.toThrow(
			/exited with code 3.*asked to die/,
		);
		const second = await helper.request<{ pid: number }>({ op: "ping" });
		expect(second.pid).not.toBe(first.pid);
	});

	it("refuses requests after dispose", async () => {
		const helper = await fakeHelper();
		await helper.request({ op: "ping" });
		await helper.dispose();
		expect(helper.isRunning).toBe(false);
		await expect(helper.request({ op: "ping" })).rejects.toThrow("disposed");
	});
});
