import { describe, expect, it } from "bun:test";
import { killProcessTree, treeSpawnOptions } from "../src/utils/processTree.ts";

describe("treeSpawnOptions", () => {
	it("detaches into a process group on posix", () => {
		expect(treeSpawnOptions("darwin")).toEqual({
			detached: true,
			windowsHide: true,
		});
		expect(treeSpawnOptions("linux")).toEqual({
			detached: true,
			windowsHide: true,
		});
	});

	it("does not detach on win32", () => {
		expect(treeSpawnOptions("win32")).toEqual({
			detached: false,
			windowsHide: true,
		});
	});
});

interface KillCall {
	pid: number;
	signal: NodeJS.Signals;
}

function makeChild(pid: number | undefined) {
	const kills: NodeJS.Signals[] = [];
	return {
		child: {
			pid,
			kill: (signal?: NodeJS.Signals) => {
				if (signal) kills.push(signal);
				return true;
			},
		},
		kills,
	};
}

describe("killProcessTree", () => {
	it("signals the process group on posix", () => {
		const { child, kills } = makeChild(123);
		const groupKills: KillCall[] = [];
		killProcessTree(child, "SIGTERM", {
			platform: "darwin",
			kill: (pid, signal) => {
				groupKills.push({ pid, signal });
				return true;
			},
		});
		expect(groupKills).toEqual([{ pid: -123, signal: "SIGTERM" }]);
		expect(kills).toEqual([]);
	});

	it("falls back to the child when the group signal fails", () => {
		const { child, kills } = makeChild(123);
		killProcessTree(child, "SIGKILL", {
			platform: "linux",
			kill: () => {
				throw new Error("ESRCH");
			},
		});
		expect(kills).toEqual(["SIGKILL"]);
	});

	it("kills the tree with taskkill on win32", () => {
		const { child, kills } = makeChild(456);
		const spawns: { command: string; args: string[] }[] = [];
		killProcessTree(child, "SIGTERM", {
			platform: "win32",
			spawnProcess: (command, args) => {
				spawns.push({ command, args });
				return {};
			},
		});
		expect(spawns).toEqual([
			{ command: "taskkill", args: ["/pid", "456", "/T", "/F"] },
		]);
		expect(kills).toEqual([]);
	});

	it("falls back to the child when taskkill cannot spawn", () => {
		const { child, kills } = makeChild(456);
		killProcessTree(child, "SIGTERM", {
			platform: "win32",
			spawnProcess: () => {
				throw new Error("ENOENT");
			},
		});
		expect(kills).toEqual(["SIGTERM"]);
	});

	it("falls back to the child when taskkill fails asynchronously", () => {
		const { child, kills } = makeChild(456);
		let errorListener: (() => void) | undefined;
		killProcessTree(child, "SIGTERM", {
			platform: "win32",
			spawnProcess: () => ({
				once: (_event, listener) => {
					errorListener = listener;
				},
			}),
		});
		expect(kills).toEqual([]);
		errorListener?.();
		expect(kills).toEqual(["SIGTERM"]);
	});

	it("signals the child directly when the pid is unknown", () => {
		const { child, kills } = makeChild(undefined);
		const groupKills: KillCall[] = [];
		killProcessTree(child, "SIGTERM", {
			platform: "darwin",
			kill: (pid, signal) => {
				groupKills.push({ pid, signal });
				return true;
			},
		});
		expect(groupKills).toEqual([]);
		expect(kills).toEqual(["SIGTERM"]);
	});
});
