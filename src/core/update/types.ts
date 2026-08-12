/** Shape returned by the backend `GET /cli/version` endpoint. */
export interface CliVersionInfo {
	version: string;
	download_url?: string;
	checksum_sha256?: string | null;
	invite_code_required?: boolean;
}

export type UpdateCheckStatus = "up-to-date" | "update-available" | "error";

export interface UpdateCheckResult {
	status: UpdateCheckStatus;
	currentVersion: string;
	latestVersion?: string;
	/** Install/upgrade command to show the user. */
	command: string;
	error?: string;
}

export type FetchLike = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface CheckForCliUpdateParams {
	apiUrl: string;
	currentVersion: string;
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}
