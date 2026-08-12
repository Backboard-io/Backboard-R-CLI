import { DEFAULT_API_URL, normalizeApiUrl } from "../../config/env.ts";
import {
	DEFAULT_OAUTH_CLIENT_ID,
	DEFAULT_OAUTH_SCOPE,
	DEFAULT_TIMEOUT_MS,
	DEVICE_CODE_GRANT_TYPE,
} from "./BackboardOAuthConstants.ts";
import {
	formatBackboardOAuthTokenError,
	parseBackboardOAuthTokenResponse,
} from "./BackboardOAuthToken.ts";
import type {
	BackboardDeviceCodeResponse,
	BackboardDeviceLoginOptions,
	BackboardOAuthLoginResult,
	BackboardOAuthTokenResponse,
	ExchangeDeviceCodeInput,
	FetchFn,
	RequestDeviceCodeInput,
} from "./BackboardOAuthTypes.ts";

export type {
	BackboardDeviceCodeResponse,
	BackboardOAuthLoginResult,
	BackboardOAuthTokenResponse,
	FetchFn,
} from "./BackboardOAuthTypes.ts";

export function loadOAuthClientId(
	source: Record<string, string | undefined> = process.env,
): string {
	const clientId = source.BACKBOARD_OAUTH_CLIENT_ID?.trim();
	if (clientId) return clientId;
	// Fall back to the baked-in first-party public client id so a shipped
	// binary works out of the box without any build-time env injection.
	return DEFAULT_OAUTH_CLIENT_ID;
}

export async function runBackboardDeviceLogin(
	options: BackboardDeviceLoginOptions = {},
): Promise<BackboardOAuthLoginResult> {
	const apiUrl = normalizeApiUrl(options.apiUrl ?? DEFAULT_API_URL);
	const clientId = (options.clientId ?? loadOAuthClientId()).trim();
	const scope = options.scope ?? DEFAULT_OAUTH_SCOPE;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const started = Date.now();

	const device = await requestDeviceCode({
		apiUrl,
		clientId,
		scope,
		fetchFn: options.fetchFn,
	});
	options.onDeviceCode?.(device);

	let intervalMs = Math.max(1, device.interval) * 1000;
	const expiresAt = started + Math.min(timeoutMs, device.expires_in * 1000);

	while (Date.now() < expiresAt) {
		await sleep(intervalMs);
		try {
			const token = await exchangeDeviceCode({
				apiUrl,
				clientId,
				deviceCode: device.device_code,
				fetchFn: options.fetchFn,
			});
			return {
				authorizeUrl: device.verification_uri_complete,
				redirectUri: device.verification_uri,
				token,
			};
		} catch (err) {
			if (!(err instanceof DeviceCodeTokenError)) throw err;
			if (err.code === "authorization_pending") continue;
			if (err.code === "slow_down") {
				intervalMs += 5000;
				continue;
			}
			if (err.code === "access_denied") {
				throw new Error("Backboard device login was denied.");
			}
			if (err.code === "expired_token") {
				throw new Error("Backboard device login code expired.");
			}
			throw err;
		}
	}

	throw new Error("Timed out waiting for Backboard device login.");
}

export async function requestDeviceCode(
	input: RequestDeviceCodeInput,
): Promise<BackboardDeviceCodeResponse> {
	const fetchImpl: FetchFn = input.fetchFn ?? ((url, init) => fetch(url, init));
	const body = new URLSearchParams({
		client_id: input.clientId,
		scope: input.scope,
	});
	const response = await fetchImpl(
		`${normalizeApiUrl(input.apiUrl)}/oauth/device/code`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		},
	);
	const text = await response.text();
	if (!response.ok) {
		throw new Error(formatBackboardOAuthTokenError(response.status, text));
	}
	return parseDeviceCodeResponse(text);
}

export async function exchangeDeviceCode(
	input: ExchangeDeviceCodeInput,
): Promise<BackboardOAuthTokenResponse> {
	const fetchImpl: FetchFn = input.fetchFn ?? ((url, init) => fetch(url, init));
	const body = new URLSearchParams({
		grant_type: DEVICE_CODE_GRANT_TYPE,
		device_code: input.deviceCode,
		client_id: input.clientId,
	});
	const response = await fetchImpl(
		`${normalizeApiUrl(input.apiUrl)}/oauth/token`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		},
	);
	const text = await response.text();
	if (!response.ok) {
		const parsed = parseOAuthError(text);
		if (parsed.error) {
			throw new DeviceCodeTokenError(parsed.error, parsed.description);
		}
		throw new Error(formatBackboardOAuthTokenError(response.status, text));
	}
	return parseBackboardOAuthTokenResponse(text);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeviceCodeTokenError extends Error {
	constructor(
		readonly code: string,
		description: string | null,
	) {
		super(description ? `${code}: ${description}` : code);
		this.name = "DeviceCodeTokenError";
	}
}

function parseOAuthError(text: string): {
	error: string | null;
	description: string | null;
} {
	if (!text) return { error: null, description: null };
	try {
		const value = JSON.parse(text) as unknown;
		if (!isRecord(value)) return { error: null, description: text };
		const error = typeof value.error === "string" ? value.error : null;
		const description =
			typeof value.error_description === "string"
				? value.error_description
				: typeof value.detail === "string"
					? value.detail
					: null;
		return { error, description };
	} catch {
		return { error: null, description: text };
	}
}

function parseDeviceCodeResponse(text: string): BackboardDeviceCodeResponse {
	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch {
		throw new Error("Backboard device-code response was not valid JSON.");
	}
	if (!isRecord(value)) {
		throw new Error("Backboard device-code response was not an object.");
	}
	return {
		device_code: requiredString(value, "device_code"),
		user_code: requiredString(value, "user_code"),
		verification_uri: requiredString(value, "verification_uri"),
		verification_uri_complete: requiredString(
			value,
			"verification_uri_complete",
		),
		expires_in: requiredNumber(value, "expires_in"),
		interval: requiredNumber(value, "interval"),
	};
}

function requiredString(raw: Record<string, unknown>, key: string): string {
	const value = raw[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`Backboard device-code response is missing ${key}.`);
	}
	return value;
}

function requiredNumber(raw: Record<string, unknown>, key: string): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Backboard device-code response is missing ${key}.`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
