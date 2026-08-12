import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { LspFlags } from "./flags.ts";

export type BinaryResolutionResult =
	| { ok: true; path: string }
	| { ok: false; reason: string };

/**
 * Binary resolution for language servers, layered the same way opencode does it
 * but adapted to our environment:
 *
 *   1. the pre-provisioned cache dir (mounted into eval sandboxes),
 *   2. the host PATH (dev machines / pre-baked images),
 *   3. an on-demand npm install into the cache dir (only when downloads are
 *      allowed) for npm-distributed servers.
 *
 * Anything that cannot be resolved returns `undefined`; the caller then skips
 * that server silently so a missing language degrades to "no diagnostics"
 * rather than an error.
 */

const IS_WINDOWS = process.platform === "win32";

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function candidateNames(bin: string): string[] {
	if (!IS_WINDOWS) return [bin];
	return [bin, `${bin}.cmd`, `${bin}.exe`, `${bin}.bat`];
}

/** Locate an executable on a PATH-like list of directories. */
async function findOnPath(
	bin: string,
	dirs: string[],
): Promise<string | undefined> {
	for (const dir of dirs) {
		if (!dir) continue;
		for (const name of candidateNames(bin)) {
			const full = join(dir, name);
			if (await isExecutable(full)) return full;
		}
	}
	return undefined;
}

function cacheBinDirs(flags: LspFlags): string[] {
	return [flags.cacheDir, join(flags.cacheDir, "bin"), npmBinDir(flags)];
}

function pathDirs(): string[] {
	return (process.env.PATH ?? "").split(delimiter).filter(Boolean);
}

function npmPrefixDir(flags: LspFlags): string {
	return join(flags.cacheDir, "npm");
}

function npmBinDir(flags: LspFlags): string {
	return join(npmPrefixDir(flags), "node_modules", ".bin");
}

/** Resolve a plain binary by name from the cache dir then PATH. */
export async function resolveBinary(
	bin: string,
	flags: LspFlags,
): Promise<string | undefined> {
	const result = await resolveBinaryDetailed(bin, flags);
	return result.ok ? result.path : undefined;
}

export async function resolveBinaryDetailed(
	bin: string,
	flags: LspFlags,
): Promise<BinaryResolutionResult> {
	const resolved =
		(await findOnPath(bin, cacheBinDirs(flags))) ??
		(await findOnPath(bin, pathDirs()));
	if (resolved) return { ok: true, path: resolved };
	return {
		ok: false,
		reason: `binary '${bin}' was not found in ${flags.cacheDir} or PATH`,
	};
}

const npmInstalls = new Map<string, Promise<void>>();

/**
 * Resolve a binary provided by an npm package, installing it into the cache dir
 * on a miss when downloads are allowed. Installs are de-duped per package.
 */
export async function resolveNpmBinary(
	pkg: string,
	bin: string,
	flags: LspFlags,
): Promise<string | undefined> {
	const result = await resolveNpmBinaryDetailed(pkg, bin, flags);
	return result.ok ? result.path : undefined;
}

export async function resolveNpmBinaryDetailed(
	pkg: string,
	bin: string,
	flags: LspFlags,
): Promise<BinaryResolutionResult> {
	const existing = await resolveBinaryDetailed(bin, flags);
	if (existing.ok) return existing;
	if (!flags.allowDownload) {
		return {
			ok: false,
			reason: `${existing.reason}; downloads are disabled`,
		};
	}

	try {
		await ensureNpmInstall(pkg, flags);
	} catch (error) {
		return {
			ok: false,
			reason: `${existing.reason}; npm install for '${pkg}' failed: ${formatInstallError(error)}`,
		};
	}
	const installed = await findOnPath(bin, [npmBinDir(flags)]);
	if (installed) return { ok: true, path: installed };
	return {
		ok: false,
		reason: `npm package '${pkg}' installed but binary '${bin}' was not found in ${npmBinDir(flags)}`,
	};
}

async function ensureNpmInstall(pkg: string, flags: LspFlags): Promise<void> {
	const key = `${flags.cacheDir}::${pkg}`;
	const inflight = npmInstalls.get(key);
	if (inflight) return inflight;

	const task = (async () => {
		const prefix = npmPrefixDir(flags);
		await mkdir(prefix, { recursive: true });
		await runInstall(pkg, prefix);
	})();
	npmInstalls.set(key, task);
	return task;
}

function runInstall(pkg: string, prefix: string): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		// `npm install --prefix` lays the package out at <prefix>/node_modules
		// with bin shims under node_modules/.bin, which is what we resolve from.
		const child = spawn(
			"npm",
			[
				"install",
				"--prefix",
				prefix,
				"--no-save",
				"--no-audit",
				"--no-fund",
				"--ignore-scripts",
				pkg,
			],
			{ stdio: "ignore" },
		);
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`npm install timed out for ${pkg}`));
		}, 120_000);
		timer.unref?.();
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise();
			else reject(new Error(`npm install failed for ${pkg} (exit ${code})`));
		});
	});
}

function formatInstallError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	return String(error);
}
