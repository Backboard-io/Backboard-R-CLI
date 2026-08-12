import { existsSync } from "node:fs";

export type CommandShellKind = "bash" | "posix";

export interface CommandShell {
	kind: CommandShellKind;
	path: string;
}

const BASH_CANDIDATES = [
	process.env.BASH,
	"/bin/bash",
	"/usr/bin/bash",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/bash",
].filter((path): path is string => Boolean(path));

export function detectCommandShell(
	exists: (path: string) => boolean = existsSync,
): CommandShell {
	for (const path of BASH_CANDIDATES) {
		if (exists(path)) return { kind: "bash", path };
	}
	return {
		kind: "posix",
		path: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
	};
}
