import type { CheckForCliUpdateParams } from "./types.ts";
import { checkForCliUpdate } from "./updateCheck.ts";

/** Set to any non-empty value to skip the automatic startup version check. */
export const NO_UPDATE_CHECK_ENV = "BACKBOARD_NO_UPDATE_CHECK";

/** Available-update details surfaced in the startup session card. */
export interface StartupUpdateInfo {
	/** Version currently running. */
	current: string;
	/** Newer version published by the backend. */
	latest: string;
}

/**
 * Fire-and-forget startup version check. Resolves to update details only when
 * a newer version is published; resolves to `null` when up to date, when the
 * check is disabled, or when the backend is slow/unreachable — so startup
 * stays silent unless there is genuinely something to install. Never throws:
 * `checkForCliUpdate` folds errors into its result, and the "error" status
 * maps to `null` here.
 */
export async function fetchStartupUpdate(
	params: CheckForCliUpdateParams,
	env: Record<string, string | undefined> = process.env,
): Promise<StartupUpdateInfo | null> {
	if (env[NO_UPDATE_CHECK_ENV]) return null;
	const result = await checkForCliUpdate(params);
	if (result.status !== "update-available" || !result.latestVersion) {
		return null;
	}
	return { current: result.currentVersion, latest: result.latestVersion };
}
