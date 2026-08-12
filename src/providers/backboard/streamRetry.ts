import { BackboardError, BackboardTransportError } from "./errors.ts";

export const DEFAULT_STREAM_SERVER_ERROR_RETRIES = 2;
export const STREAM_SERVER_ERROR_RETRIES_ENV =
	"Q_CLI_STREAM_SERVER_ERROR_RETRIES";

const RETRYABLE_STATUS_CODES = new Set([502, 503, 504]);

const RETRYABLE_MESSAGE_PATTERNS = [
	"upstream idle timeout exceeded",
	"failed to continue streaming after tool outputs",
	"operation timed out",
	"socket connection was closed",
	"stream closed unexpectedly",
	"connection reset",
	"connection closed",
	"remote protocol error",
	"read timeout",
	"gateway timeout",
	"bad gateway",
	"service unavailable",
	"http 502",
	"http 503",
	"http 504",
];

const NON_RETRYABLE_MESSAGE_PATTERNS = [
	"abort",
	"cancelled",
	"canceled",
	"malformed",
	"invalid request",
	"unauthorized",
	"forbidden",
	"authentication",
	"api key",
	"credit balance",
	"insufficient credits",
	"quota",
	"rate limit",
	"tool outputs without tool calls",
];

export function streamServerErrorRetries(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = env[STREAM_SERVER_ERROR_RETRIES_ENV];
	if (raw == null || raw.trim() === "")
		return DEFAULT_STREAM_SERVER_ERROR_RETRIES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return DEFAULT_STREAM_SERVER_ERROR_RETRIES;
	}
	return Math.floor(parsed);
}

export function isRetryableStreamServerErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	if (!normalized) return false;
	if (
		NON_RETRYABLE_MESSAGE_PATTERNS.some((pattern) =>
			normalized.includes(pattern),
		)
	) {
		return false;
	}
	return RETRYABLE_MESSAGE_PATTERNS.some((pattern) =>
		normalized.includes(pattern),
	);
}

export function isRetryableStreamServerError(error: unknown): boolean {
	if (error instanceof BackboardError) {
		return (
			RETRYABLE_STATUS_CODES.has(error.status) ||
			isRetryableStreamServerErrorMessage(error.message)
		);
	}
	if (error instanceof BackboardTransportError) {
		return (
			(error.phase === "stream" || error.phase === "request") &&
			isRetryableStreamServerErrorMessage(error.message)
		);
	}
	if (error instanceof Error) {
		return isRetryableStreamServerErrorMessage(error.message);
	}
	return isRetryableStreamServerErrorMessage(String(error));
}

export function streamRetryDelayMs(attempt: number): number {
	return Math.min(250 * 2 ** Math.max(0, attempt - 1), 2_000);
}
