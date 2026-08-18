import { randomUUID } from "node:crypto";
import {
	appendFile,
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export async function ensureDir(path: string, mode?: number): Promise<void> {
	await mkdir(path, { recursive: true, mode });
}

export async function appendLine(
	filePath: string,
	line: string,
): Promise<void> {
	await ensureDir(dirname(filePath), 0o700);
	await appendFile(filePath, line.endsWith("\n") ? line : `${line}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function readUtf8(path: string): Promise<string> {
	return readFile(path, "utf8");
}

export async function writePrivateFileAtomic(
	path: string,
	content: string,
): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
	try {
		await writeFile(temporary, content, { mode: 0o600 });
		await chmod(temporary, 0o600).catch(() => undefined);
		await renameOverPreservingDestination(temporary, path);
		await chmod(path, 0o600).catch(() => undefined);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

export async function fileSize(path: string): Promise<number> {
	const s = await stat(path);
	return s.size;
}

export function isErrnoException(
	error: unknown,
): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/** Removes a file, tolerating one that is already gone. */
export async function unlinkTolerant(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (isErrnoException(error) && error.code === "ENOENT") return;
		throw error;
	}
}

/**
 * Renames `temp` over `dest`, with an unlink+rename fallback on EEXIST/EPERM
 * and one retry on EBUSY (Windows AV scanners briefly lock fresh files).
 */
export async function renameOver(temp: string, dest: string): Promise<void> {
	try {
		await rename(temp, dest);
	} catch (error) {
		if (!isErrnoException(error)) throw error;
		if (error.code === "EEXIST" || error.code === "EPERM") {
			await unlinkTolerant(dest);
			await rename(temp, dest);
			return;
		}
		if (error.code === "EBUSY") {
			await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
			await rename(temp, dest);
			return;
		}
		throw error;
	}
}

/**
 * Replaces `dest` without deleting the last valid copy first. This is for
 * credential/config files where renameOver's unlink fallback would create a
 * data-loss window on Windows.
 */
export async function renameOverPreservingDestination(
	temp: string,
	dest: string,
): Promise<void> {
	let renameError: unknown;
	try {
		await rename(temp, dest);
		return;
	} catch (error) {
		renameError = error;
	}

	if (isErrnoException(renameError) && renameError.code === "EBUSY") {
		await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
		try {
			await rename(temp, dest);
			return;
		} catch (error) {
			renameError = error;
		}
	}
	if (!isErrnoException(renameError)) throw renameError;
	if (renameError.code !== "EEXIST" && renameError.code !== "EPERM") {
		throw renameError;
	}

	const backup = `${dest}.backup-${randomUUID()}`;
	let preserved = false;
	try {
		try {
			await rename(dest, backup);
			preserved = true;
		} catch (error) {
			if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
		}
		await rename(temp, dest);
	} catch (error) {
		if (preserved) {
			await rename(backup, dest).catch(() => undefined);
		}
		throw error;
	}
	if (preserved) await unlinkTolerant(backup);
}
