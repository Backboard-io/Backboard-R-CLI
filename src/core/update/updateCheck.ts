import { normalizeApiUrl } from "../../config/env.ts";
import { errorMessage } from "../../utils/errors.ts";
import { CLI_VERSION_PATH, UPDATE_CHECK_TIMEOUT_MS } from "./constants.ts";
import type {
	CheckForCliUpdateParams,
	CliVersionInfo,
	UpdateCheckResult,
} from "./types.ts";

/** Unix/macOS install one-liner served by the backend (`${apiUrl}/cli`). */
export function cliInstallCommand(apiUrl: string): string {
	return `curl -fsSL ${normalizeApiUrl(apiUrl)}/cli | sh`;
}

function parseSemver(value: string): [number, number, number] {
	const core = value.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
	const parts = core.split(".");
	const at = (index: number): number => {
		const parsed = Number.parseInt(parts[index] ?? "0", 10);
		return Number.isFinite(parsed) ? parsed : 0;
	};
	return [at(0), at(1), at(2)];
}

/** Returns >0 if a is newer, <0 if older, 0 if equal (ignores pre-release). */
export function compareSemver(a: string, b: string): number {
	const left = parseSemver(a);
	const right = parseSemver(b);
	for (let i = 0; i < 3; i += 1) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
	return compareSemver(latest, current) > 0;
}

/**
 * Checks the backend for the latest published CLI version and compares it with
 * the running version. Never throws: transport/parse failures resolve to an
 * "error" result so the caller can render a single notice.
 */
export async function checkForCliUpdate(
	params: CheckForCliUpdateParams,
): Promise<UpdateCheckResult> {
	const { apiUrl, currentVersion } = params;
	const fetchImpl = params.fetchImpl ?? fetch;
	const command = cliInstallCommand(apiUrl);
	const url = `${normalizeApiUrl(apiUrl)}${CLI_VERSION_PATH}`;

	const timeout = AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS);
	const signal = params.signal
		? AbortSignal.any([params.signal, timeout])
		: timeout;

	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { accept: "application/json" },
			signal,
		});
		if (!response.ok) {
			return {
				status: "error",
				currentVersion,
				command,
				error: `version check failed (HTTP ${response.status})`,
			};
		}
		const data = (await response.json()) as Partial<CliVersionInfo>;
		const latestVersion =
			typeof data.version === "string" ? data.version.trim() : "";
		if (!latestVersion) {
			return {
				status: "error",
				currentVersion,
				command,
				error: "version check returned no version",
			};
		}
		return {
			status: isNewerVersion(latestVersion, currentVersion)
				? "update-available"
				: "up-to-date",
			currentVersion,
			latestVersion,
			command,
		};
	} catch (err) {
		return {
			status: "error",
			currentVersion,
			command,
			error: errorMessage(err),
		};
	}
}
