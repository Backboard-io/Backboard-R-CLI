import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { detectCommandShell } from "../src/utils/commandShell.ts";
import { makeContext } from "./helpers.ts";

describe("detectCommandShell", () => {
	it("prefers bash when available", () => {
		const shell = detectCommandShell((path) => path === "/bin/bash");

		expect(shell).toEqual({ kind: "bash", path: "/bin/bash" });
	});

	it("falls back to POSIX sh when bash is unavailable", () => {
		const shell = detectCommandShell(() => false);

		expect(shell.kind).toBe("posix");
		expect(shell.path).toBe(
			process.platform === "win32" ? "cmd.exe" : "/bin/sh",
		);
	});

	it("runs commands through bash when bash is available", async () => {
		if (!existsSync("/bin/bash") && !existsSync("/usr/bin/bash")) return;

		const tool = new ExecuteTool();
		const result = await tool.execute(
			{ command: "arr=(zero one); echo $" + "{arr[1]}" },
			makeContext(new AbortController().signal),
		);

		expect(result.data.exitCode).toBe(0);
		expect(result.data.stdout?.trim()).toBe("one");
	});

	it("starts fire-and-forget commands with a pid and log path", async () => {
		const tool = new ExecuteTool();
		const result = await tool.execute(
			{ command: "printf ready", fireAndForget: true },
			makeContext(new AbortController().signal),
		);

		expect(result.data.fireAndForget).toBe(true);
		expect(result.data.pid).toBeNumber();
		expect(result.data.logPath).toBeString();
		expect(result.forLLM).toContain("pid:");
		expect(result.forLLM).toContain("log path:");
		if (!result.data.logPath) throw new Error("expected log path");

		let content = "";
		for (let attempt = 0; attempt < 20; attempt++) {
			content = await readFile(result.data.logPath, "utf8");
			if (content.includes("ready")) break;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(content).toContain("ready");
	});

	it("does not apply timeout to fire-and-forget commands", async () => {
		const tool = new ExecuteTool();
		const result = await tool.execute(
			{ command: "sleep 5", timeout: 1, fireAndForget: true },
			makeContext(new AbortController().signal),
		);
		const pid = result.data.pid;
		if (pid === undefined) throw new Error("expected pid");

		await new Promise((resolve) => setTimeout(resolve, 1_200));

		expect(isProcessAlive(pid)).toBe(true);
		killProcessGroup(pid);
	});

	it("uses friendly command result titles", async () => {
		const tool = new ExecuteTool();
		const success = await tool.execute(
			{ command: "echo ok" },
			makeContext(new AbortController().signal),
		);
		const failed = await tool.execute(
			{ command: "echo bad news >&2; exit 1" },
			makeContext(new AbortController().signal),
		);

		expect(success.title).toBe("Success");
		// The detail carries a multi-line preview: the command, then its output.
		expect(success.detail).toBe("$ echo ok\nstdout:\nok");
		expect(failed.title).toBe("Failed: bad news");
		expect(failed.detail).toBe(
			"$ echo bad news >&2; exit 1\nstderr:\nbad news",
		);
	});

	it("strips ANSI color codes from the result title", async () => {
		const tool = new ExecuteTool();
		const result = await tool.execute(
			{ command: "printf '\\033[31mbad news\\033[0m\\n' >&2; exit 1" },
			makeContext(new AbortController().signal),
		);

		expect(result.title).toBe("Failed: bad news");
	});
});

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// process already exited
		}
	}
}
