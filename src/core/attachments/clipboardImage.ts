import { spawn } from "node:child_process";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { CandidateFile } from "./attachmentPaths.ts";
import { MAX_ATTACHMENT_BYTES } from "./constants.ts";

export type ClipboardImageResult =
	| { kind: "image"; file: CandidateFile }
	| { kind: "none" }
	| { kind: "too-large" };

export interface ClipboardImageDeps {
	platform: NodeJS.Platform;
	tmpdir: () => string;
	now: () => number;
	exec: (command: string, args: string[]) => Promise<{ code: number }>;
	statSync: (path: string) => { size: number };
	unlinkSync: (path: string) => void;
}

const COMMAND_TIMEOUT_MS = 10_000;

function execCommand(
	command: string,
	args: string[],
): Promise<{ code: number }> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			stdio: "ignore",
			timeout: COMMAND_TIMEOUT_MS,
		});
		child.on("error", () => resolve({ code: -1 }));
		child.on("close", (code) => resolve({ code: code ?? -1 }));
	});
}

const defaultDeps: ClipboardImageDeps = {
	platform: process.platform,
	tmpdir,
	now: Date.now,
	exec: execCommand,
	statSync,
	unlinkSync,
};

/** Command that writes the clipboard image to targetPath, or null when the platform has none. */
function saveClipboardImageCommand(
	platform: NodeJS.Platform,
	targetPath: string,
): { command: string; args: string[] } | null {
	if (platform === "darwin") {
		return {
			command: "osascript",
			args: [
				"-e",
				"on run argv",
				"-e",
				"set png_data to (the clipboard as «class PNGf»)",
				"-e",
				"set fp to open for access POSIX file (item 1 of argv) with write permission",
				"-e",
				"write png_data to fp",
				"-e",
				"close access fp",
				"-e",
				"end run",
				targetPath,
			],
		};
	}
	if (platform === "linux") {
		return {
			command: "/bin/sh",
			args: [
				"-c",
				'xclip -selection clipboard -t image/png -o > "$1" 2>/dev/null || wl-paste --type image/png > "$1" 2>/dev/null',
				"_",
				targetPath,
			],
		};
	}
	if (platform === "win32") {
		return {
			command: "powershell",
			args: [
				"-NoProfile",
				"-Command",
				`$img = Get-Clipboard -Format Image; if ($img -eq $null) { exit 1 }; $img.Save('${targetPath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
			],
		};
	}
	return null;
}

const CLIPBOARD_IMAGE_PREFIX = "backboard-clipboard-";
const STALE_CLIPBOARD_IMAGE_MS = 24 * 60 * 60 * 1000;

let sequence = 0;

/** Saves the clipboard image to a unique temp PNG; the file must outlive staging so upload can read it. */
export async function readClipboardImage(
	deps: ClipboardImageDeps = defaultDeps,
): Promise<ClipboardImageResult> {
	sequence += 1;
	const filePath = join(
		deps.tmpdir(),
		`${CLIPBOARD_IMAGE_PREFIX}${deps.now()}-${sequence}.png`,
	);
	const save = saveClipboardImageCommand(deps.platform, filePath);
	if (!save) return { kind: "none" };

	const result = await deps.exec(save.command, save.args);
	if (result.code !== 0) {
		tryUnlink(deps, filePath);
		return { kind: "none" };
	}

	let sizeBytes = 0;
	try {
		sizeBytes = deps.statSync(filePath).size;
	} catch {
		return { kind: "none" };
	}
	if (sizeBytes === 0) {
		tryUnlink(deps, filePath);
		return { kind: "none" };
	}
	if (sizeBytes > MAX_ATTACHMENT_BYTES) {
		tryUnlink(deps, filePath);
		return { kind: "too-large" };
	}
	return {
		kind: "image",
		file: { filePath, fileName: basename(filePath), sizeBytes },
	};
}

function tryUnlink(
	deps: Pick<ClipboardImageDeps, "unlinkSync">,
	filePath: string,
): void {
	try {
		deps.unlinkSync(filePath);
	} catch {
		// Nothing to clean up.
	}
}

export interface ClipboardCleanupDeps {
	tmpdir: () => string;
	now: () => number;
	readdirSync: (dir: string) => string[];
	unlinkSync: (path: string) => void;
}

const defaultCleanupDeps: ClipboardCleanupDeps = {
	tmpdir,
	now: Date.now,
	readdirSync,
	unlinkSync,
};

/** Deletes the temp PNGs this module created among the given paths; user files are left alone. */
export function cleanupClipboardImages(
	paths: readonly string[],
	deps: ClipboardCleanupDeps = defaultCleanupDeps,
): void {
	for (const filePath of paths) {
		if (dirname(filePath) !== deps.tmpdir()) continue;
		if (!basename(filePath).startsWith(CLIPBOARD_IMAGE_PREFIX)) continue;
		tryUnlink(deps, filePath);
	}
}

/** Best-effort startup sweep of clipboard temp PNGs left behind by earlier runs. */
export function sweepStaleClipboardImages(
	deps: ClipboardCleanupDeps = defaultCleanupDeps,
): void {
	let names: string[];
	try {
		names = deps.readdirSync(deps.tmpdir());
	} catch {
		return;
	}
	for (const name of names) {
		const match = /^backboard-clipboard-(\d+)-\d+\.png$/.exec(name);
		if (!match) continue;
		const createdAt = Number(match[1]);
		if (deps.now() - createdAt < STALE_CLIPBOARD_IMAGE_MS) continue;
		tryUnlink(deps, join(deps.tmpdir(), name));
	}
}
