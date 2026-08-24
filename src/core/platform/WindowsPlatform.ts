import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDir, fileExists } from "../../utils/fs.ts";
import { HelperPlatform } from "./HelperPlatform.ts";
import { HelperProcess } from "./HelperProcess.ts";
import helperSource from "./windows/cuaHelper.ps1" with { type: "text" };

export const WINDOWS_HELPER_SOURCE: string = helperSource;

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
	const path = join(dir, "cua-helper.ps1");
	if (!(await fileExists(path)) || (await Bun.file(path).text()) !== source) {
		await writeFile(path, source, "utf8");
	}
	return path;
}
