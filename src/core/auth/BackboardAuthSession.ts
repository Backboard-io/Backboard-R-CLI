import os from "node:os";
import {
	deleteBackboardConfig,
	readBackboardConfig,
	saveBackboardConfig,
} from "../../config/backboardConfig.ts";
import { APP_COMMAND_NAME, APP_DISPLAY_NAME } from "../../config/branding.ts";
import { resolveApiUrl } from "../../config/env.ts";
import { openDefaultBrowser } from "../oauth/LoopbackOAuth.ts";
import { runBackboardDeviceLogin } from "./BackboardOAuth.ts";
import type { BackboardSsoLoginOptions } from "./BackboardOAuthTypes.ts";

export async function loginWithBackboardSso(
	options: BackboardSsoLoginOptions = {},
): Promise<string> {
	const apiUrl = resolveApiUrl(readBackboardConfig().apiUrl);
	const result = await runBackboardDeviceLogin({
		apiUrl,
		onDeviceCode: (device) => {
			options.onDeviceCode?.(device);
			// Best effort: the URL and code are always printed as a fallback.
			if (canOpenBrowser()) {
				void openDefaultBrowser(device.verification_uri_complete).catch(
					() => undefined,
				);
			}
		},
	});
	// Prefer the workspace key; fall back to the personal key when the selected
	// organization has no API key yet (e.g. a freshly created org).
	const apiKey =
		result.token.backboard_api_key || result.token.personal_api_key;
	if (!apiKey) {
		throw new Error(
			"Backboard SSO did not return a workspace or personal API key. Check that the OAuth client returns individual user tokens, or set BACKBOARD_API_KEY for non-interactive use.",
		);
	}
	const configPath = await saveBackboardConfig({
		apiKey,
		apiUrl,
	});

	return `Signed in with ${APP_DISPLAY_NAME}. Credentials saved to ${configPath}.`;
}

// Auto-open a browser only on an interactive desktop session.
function canOpenBrowser(): boolean {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
	if (process.env.CI) return false;
	if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
	if (os.platform() === "linux") {
		return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	}
	return true;
}

export async function logoutSavedCredentials(): Promise<string> {
	const result = await deleteBackboardConfig();
	const message = result.removed
		? `Signed out. Removed saved credentials from ${result.path}.`
		: `No saved Backboard credentials found at ${result.path}.`;

	if (process.env.BACKBOARD_API_KEY) {
		return `${message}\nBACKBOARD_API_KEY is still set in this shell, so ${APP_COMMAND_NAME} will keep using it until you unset it.`;
	}

	return message;
}
