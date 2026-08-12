import { type ChildProcess, spawn } from "node:child_process";

export interface TreeSpawnOptions {
	detached: boolean;
	windowsHide: boolean;
}

export function treeSpawnOptions(
	platform: NodeJS.Platform = process.platform,
): TreeSpawnOptions {
	return { detached: platform !== "win32", windowsHide: true };
}

type KillTarget = Pick<ChildProcess, "pid" | "kill">;

export interface KillProcessTreeIo {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals) => unknown;
	spawnProcess?: (
		command: string,
		args: string[],
		options: { stdio: "ignore"; windowsHide: boolean },
	) => {
		unref?: () => void;
		once?: (event: "error", listener: () => void) => unknown;
	};
}

export function killProcessTree(
	child: KillTarget,
	signal: NodeJS.Signals,
	io: KillProcessTreeIo = {},
): void {
	const platform = io.platform ?? process.platform;
	const pid = child.pid;
	const killChild = () => {
		try {
			child.kill(signal);
		} catch {}
	};
	if (pid === undefined) {
		killChild();
		return;
	}
	if (platform === "win32") {
		const spawnProcess = io.spawnProcess ?? spawn;
		try {
			const killer = spawnProcess(
				"taskkill",
				["/pid", String(pid), "/T", "/F"],
				{ stdio: "ignore", windowsHide: true },
			);
			killer.once?.("error", killChild);
			killer.unref?.();
		} catch {
			killChild();
		}
		return;
	}
	const kill = io.kill ?? process.kill;
	try {
		kill(-pid, signal);
	} catch {
		killChild();
	}
}
