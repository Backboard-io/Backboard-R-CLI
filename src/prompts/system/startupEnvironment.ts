import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { arch, platform, release, type } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_ENTRIES = 30;

/**
 * Operational context gathered once at session start: things that change a
 * coding decision (date, git state, which tools exist) rather than hardware
 * trivia. "Not found" entries are listed explicitly so the model does not
 * waste a failing call discovering an absent tool.
 */
const TOOL_PROBES: ReadonlyArray<{ name: string; args: string[] }> = [
	{ name: "git", args: ["--version"] },
	{ name: "rg", args: ["--version"] },
	{ name: "gh", args: ["--version"] },
	{ name: "node", args: ["--version"] },
	{ name: "bun", args: ["--version"] },
	{ name: "python3", args: ["--version"] },
];

export async function buildStartupEnvironmentPrompt(
	cwd = process.cwd(),
): Promise<string> {
	const [entries, git, tools] = await Promise.all([
		listTopLevelEntries(cwd),
		gitSummary(cwd),
		probeTools(cwd),
	]);
	const lines = [
		"Environment (gathered at session start; re-probe only if you believe it changed)",
		`- Today's date: ${new Date().toISOString().slice(0, 10)}`,
		`- OS: ${type()} ${release()} (${platform()}/${arch()})`,
		`- CWD: ${cwd}`,
		`- Git: ${git}`,
		tools.found.length ? `- Available: ${tools.found.join(", ")}` : "",
		tools.missing.length ? `- Not found: ${tools.missing.join(", ")}` : "",
		entries ? `- Top-level entries in ${basename(cwd) || cwd}: ${entries}` : "",
	].filter(Boolean);
	return lines.join("\n");
}

async function listTopLevelEntries(cwd: string): Promise<string | null> {
	try {
		const entries = await readdir(cwd, { withFileTypes: true });
		const names = entries
			.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
			.sort((a, b) => a.localeCompare(b));
		const shown = names.slice(0, MAX_ENTRIES);
		if (names.length > shown.length) {
			shown.push(`... ${names.length - shown.length} more`);
		}
		return shown.join(", ");
	} catch {
		return null;
	}
}

async function gitSummary(cwd: string): Promise<string> {
	const branch = await safeExec(
		"git",
		["rev-parse", "--abbrev-ref", "HEAD"],
		cwd,
	);
	if (!branch) return "not a git repository";
	const originHead = await safeExec(
		"git",
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		cwd,
	);
	const defaultBranch = originHead?.split("/").pop();
	return defaultBranch && defaultBranch !== branch
		? `on branch ${branch} (default branch: ${defaultBranch})`
		: `on branch ${branch}`;
}

async function probeTools(
	cwd: string,
): Promise<{ found: string[]; missing: string[] }> {
	const results = await Promise.all(
		TOOL_PROBES.map(async (probe) => ({
			name: probe.name,
			version: await safeExec(probe.name, probe.args, cwd),
		})),
	);
	const found: string[] = [];
	const missing: string[] = [];
	for (const { name, version } of results) {
		if (version) {
			found.push(`${name} ${firstVersionToken(version)}`.trim());
		} else {
			missing.push(name);
		}
	}
	return { found, missing };
}

function firstVersionToken(versionOutput: string): string {
	const firstLine = versionOutput.split("\n")[0] ?? "";
	return firstLine.match(/\d+(\.\d+)+/)?.[0] ?? "";
}

async function safeExec(
	command: string,
	args: string[],
	cwd: string,
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 750);
	try {
		const { stdout } = await execFileAsync(command, args, {
			cwd,
			encoding: "utf8",
			signal: controller.signal,
			maxBuffer: 64 * 1024,
		});
		return stdout.trim() || null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
