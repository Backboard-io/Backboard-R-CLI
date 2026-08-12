// First-party CLI OAuth client id. This is a PUBLIC client (the API registers
// it with is_public_client=True and no secret), and the device-code grant only
// accepts this exact id — so it is safe to ship baked into the binary. Set the
// BACKBOARD_OAUTH_CLIENT_ID env var to override it against a non-prod backend.
export const DEFAULT_OAUTH_CLIENT_ID = "Backboard_oauth_q_cli";

export const DEFAULT_OAUTH_SCOPE = "email profile";

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const DEVICE_CODE_GRANT_TYPE =
	"urn:ietf:params:oauth:grant-type:device_code";
