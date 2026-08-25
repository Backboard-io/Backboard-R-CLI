import { createHash } from "node:crypto";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, fileExists } from "../../utils/fs.ts";
import { HelperPlatform } from "./HelperPlatform.ts";
import { HelperProcess } from "./HelperProcess.ts";
import helperSource from "./windows/cuaHelper.ps1" with { type: "text" };

export const WINDOWS_HELPER_SOURCE: string = helperSource;

export function windowsHelperSourceHash(
	source = WINDOWS_HELPER_SOURCE,
): string {
	return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

export function windowsHelperScriptPath(
	source = WINDOWS_HELPER_SOURCE,
): string {
	return join(
		homedir(),
		".backboard",
		"bin",
		`cua-helper-${windowsHelperSourceHash(source)}.ps1`,
	);
}

/**
 * Windows platform backed by a persistent PowerShell host
 * (`windows/cuaHelper.ps1`). The host is DPI-aware, drives input through
 * `SendInput`, reads UI Automation through a cached tree request, and stays
 * alive between actions so no call pays PowerShell's startup cost.
 */
export class WindowsPlatform extends HelperPlatform {
	readonly os = "win32" as const;

	constructor(private readonly helperPath?: string) {
		super();
	}

	protected async createHelper(): Promise<HelperProcess> {
		const scriptPath = this.helperPath ?? (await ensureWindowsHelperScript());
		return new HelperProcess({
			command: "powershell.exe",
			args: [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-File",
				scriptPath,
			],
			label: "computer-use helper",
			requestTimeoutMs: 30_000,
		});
	}
}

export async function ensureWindowsHelperScript(
	source = WINDOWS_HELPER_SOURCE,
): Promise<string> {
	const dir = join(homedir(), ".backboard", "bin");
	await ensureDir(dir);
	const path = windowsHelperScriptPath(source);
	if (await fileExists(path)) return path;
	const work = await mkdtemp(join(dir, ".cua-helper-"));
	try {
		const temporaryPath = join(work, "helper.ps1");
		await writeFile(temporaryPath, source, "utf8");
		try {
			await rename(temporaryPath, path);
		} catch (err) {
			if (!(await fileExists(path))) throw err;
		}
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	return path;
}
