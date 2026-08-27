import { createHash } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, fileExists } from "../../../utils/fs.ts";
import { runWithOutput } from "../process.ts";
import helperSource from "./cuaHelper.swift" with { type: "text" };

export const MAC_HELPER_SOURCE: string = helperSource;

/** Where compiled helpers live. One binary per source hash; old ones are pruned. */
export function macHelperDir(): string {
	return join(homedir(), ".backboard", "bin");
}

export function macHelperSourceHash(source = MAC_HELPER_SOURCE): string {
	return createHash("sha256").update(source).digest("hex").slice(0, 12);
}

export function macHelperBinaryPath(source = MAC_HELPER_SOURCE): string {
	return join(macHelperDir(), `cua-helper-${macHelperSourceHash(source)}`);
}

export interface EnsureMacHelperOptions {
	source?: string;
	signal?: AbortSignal;
	onCompileStart?: () => void;
}

/**
 * Returns the path to a compiled helper for the embedded Swift source,
 * compiling it with `swiftc` on first use. Compilation takes a few seconds once
 * per CLI version; afterwards every computer action reuses the cached binary.
 */
export async function ensureMacHelperBinary(
	options: EnsureMacHelperOptions = {},
): Promise<string> {
	const source = options.source ?? MAC_HELPER_SOURCE;
	const target = macHelperBinaryPath(source);
	if (await fileExists(target)) return target;

	options.onCompileStart?.();
	await ensureDir(macHelperDir());
	const work = await mkdtemp(join(tmpdir(), "backboard-cua-build-"));
	try {
		const sourcePath = join(work, "cuaHelper.swift");
		const output = join(work, "cua-helper");
		await writeFile(sourcePath, source, "utf8");
		try {
			await runWithOutput(
				"swiftc",
				["-O", "-suppress-warnings", "-o", output, sourcePath],
				options.signal ?? new AbortController().signal,
			);
		} catch (err) {
			throw new Error(
				`Could not compile the macOS computer-use helper. Install the Xcode Command Line Tools (xcode-select --install) and retry. ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		await chmod(output, 0o755);
		await rename(output, target);
	} finally {
		await rm(work, { recursive: true, force: true });
	}
	return target;
}
