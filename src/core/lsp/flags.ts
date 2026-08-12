import { tmpdir } from "node:os";
import path from "node:path";
import { isFalsy, isTruthy } from "../../utils/envFlags.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Runtime knobs for the LSP subsystem, resolved once from the environment.
 *
 * These mirror the spirit of opencode's runtime flags but stay flat and env
 * driven so eval runs are deterministic without touching the Config class:
 *
 * - `enabled`         master switch (default off; on when LSP=1/true).
 * - `allowDownload`   whether missing servers may be fetched/installed at
 *                     runtime. Defaults off under benchmark mode so trials are
 *                     hermetic and fast, on otherwise.
 * - `cacheDir`        directory that holds pre-provisioned server binaries and
 *                     the npm install prefix. Checked before PATH.
 */
export interface LspFlags {
	enabled: boolean;
	allowDownload: boolean;
	cacheDir: string;
}

export function resolveLspFlags(
	env: Record<string, string | undefined> = process.env,
): LspFlags {
	const benchmark = isTruthy(env.BACKBOARD_BENCHMARK);
	const enabled = isTruthy(env.BACKBOARD_LSP);

	// Downloads default off in benchmark mode (rely on the pre-provisioned
	// cache) and on otherwise. Either default can be overridden explicitly.
	let allowDownload = !benchmark;
	if (isTruthy(env.BACKBOARD_LSP_DOWNLOAD)) allowDownload = true;
	if (isFalsy(env.BACKBOARD_LSP_DOWNLOAD)) allowDownload = false;
	if (isTruthy(env.BACKBOARD_DISABLE_LSP_DOWNLOAD)) allowDownload = false;

	const cacheDir =
		absoluteDir(env.BACKBOARD_LSP_DIR) ??
		absoluteDir(env.LSP_CACHE_DIR) ??
		defaultCacheDir(env);

	return { enabled, allowDownload, cacheDir };
}

function absoluteDir(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (!path.isAbsolute(trimmed)) {
		logger.warn(
			`Ignoring relative LSP cache dir override "${trimmed}"; falling back to the default path.`,
		);
		return undefined;
	}
	return trimmed;
}

function defaultCacheDir(env: Record<string, string | undefined>): string {
	const home = env.HOME || env.USERPROFILE || "";
	return home
		? path.join(home, ".backboard", "lsp")
		: path.join(tmpdir(), "backboard-lsp");
}
