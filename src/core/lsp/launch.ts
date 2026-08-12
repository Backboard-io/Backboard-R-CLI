import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
}

/**
 * Spawns a language-server process with piped stdio so a JSON-RPC connection
 * can be attached to its stdin/stdout. stderr is piped and drained to avoid
 * back-pressure deadlocks on chatty servers.
 */
export function spawnServer(
	command: string,
	args: string[],
	options: SpawnOptions = {},
): ChildProcessWithoutNullStreams {
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	child.stderr?.resume();
	return child;
}

/**
 * Best-effort termination. Servers get a polite SIGTERM and a short grace
 * window before SIGKILL so shutdown never hangs the host process.
 */
export function stopServer(child: ChildProcessWithoutNullStreams): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	try {
		child.kill("SIGTERM");
	} catch {
		// already gone
	}
	const timer = setTimeout(() => {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}, 1000);
	timer.unref?.();
}
