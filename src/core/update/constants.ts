// Public CLI version endpoint served by app/routers/cli_installer.py. Mounted
// under the API base, so the full URL is `${apiUrl}/cli/version`.
export const CLI_VERSION_PATH = "/cli/version";

// Wall-clock budget for the `/update` version check so a slow or unreachable
// backend never hangs the interactive prompt.
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
