import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isErrnoException } from "./fs.ts";

const execFileAsync = promisify(execFile);
const PROCESS_IDENTITY_TIMEOUT_MS = 1_000;

/** Signal 0 probes liveness; EPERM means alive but owned by another user. */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isErrnoException(error) && error.code === "EPERM";
	}
}

/** Stable OS process start identity, used to distinguish recycled PIDs. */
export async function processIdentity(pid: number): Promise<string | null> {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		if (process.platform === "win32") {
			const { stdout } = await execFileAsync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("O")`,
				],
				{
					encoding: "utf8",
					timeout: PROCESS_IDENTITY_TIMEOUT_MS,
					windowsHide: true,
				},
			);
			return normalizeProcessIdentity(stdout.trim());
		}
		const { stdout } = await execFileAsync(
			"ps",
			["-o", "lstart=", "-p", String(pid)],
			{ encoding: "utf8", timeout: PROCESS_IDENTITY_TIMEOUT_MS },
		);
		return normalizeProcessIdentity(stdout.trim());
	} catch {
		return null;
	}
}

export function processIdentitiesMatch(left: string, right: string): boolean {
	if (left === right) return true;
	const leftStartedAt = parseProcessIdentity(left);
	const rightStartedAt = parseProcessIdentity(right);
	return (
		Number.isFinite(leftStartedAt) &&
		Number.isFinite(rightStartedAt) &&
		Math.abs(leftStartedAt - rightStartedAt) <= 2_000
	);
}

export function parseProcessIdentity(identity: string): number {
	const numeric = Number(identity);
	return Number.isFinite(numeric) ? numeric : Date.parse(identity);
}

function normalizeProcessIdentity(value: string): string | null {
	if (!value) return null;
	const startedAt = parseProcessIdentity(value);
	return Number.isFinite(startedAt) ? String(startedAt) : value;
}
