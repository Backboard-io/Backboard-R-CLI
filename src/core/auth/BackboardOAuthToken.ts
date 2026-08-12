import type { JsonObject, JsonValue } from "../../utils/JsonTypes.ts";
import type { BackboardOAuthTokenResponse } from "./BackboardOAuthTypes.ts";

export function parseBackboardOAuthTokenResponse(
	text: string,
): BackboardOAuthTokenResponse {
	const value = parseJson(text, "Backboard OAuth token response");
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Backboard OAuth token response was not an object.");
	}
	const token = value as JsonObject;
	return {
		access_token: requiredString(token, "access_token"),
		token_type: requiredString(token, "token_type"),
		expires_in: requiredNumber(token, "expires_in"),
		refresh_token: optionalString(token, "refresh_token"),
		scope: optionalString(token, "scope"),
		id_token: nullableString(token, "id_token"),
		assistant_id: nullableString(token, "assistant_id"),
		backboard_api_key: nullableString(token, "backboard_api_key"),
		personal_api_key: nullableString(token, "personal_api_key"),
		selected_client_name: nullableString(token, "selected_client_name"),
	};
}

export function formatBackboardOAuthTokenError(
	status: number,
	text: string,
): string {
	const detail = errorDescription(text);
	return `Backboard OAuth token exchange failed: HTTP ${status}${
		detail ? `: ${detail}` : ""
	}`;
}

function errorDescription(text: string): string | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text) as JsonValue;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return text;
		}
		const error = value as JsonObject;
		const description = error.error_description ?? error.detail ?? error.error;
		return typeof description === "string" ? description : text;
	} catch {
		return text;
	}
}

function parseJson(text: string, label: string): JsonValue {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		throw new Error(`${label} was not valid JSON.`);
	}
}

function requiredString(raw: JsonObject, key: string): string {
	const value = raw[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`Backboard OAuth token response is missing ${key}.`);
	}
	return value;
}

function optionalString(raw: JsonObject, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new Error(`Backboard OAuth token response has invalid ${key}.`);
	}
	return value;
}

function nullableString(raw: JsonObject, key: string): string | null {
	const value = raw[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error(`Backboard OAuth token response has invalid ${key}.`);
	}
	return value;
}

function requiredNumber(raw: JsonObject, key: string): number {
	const value = raw[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Backboard OAuth token response is missing ${key}.`);
	}
	return value;
}
