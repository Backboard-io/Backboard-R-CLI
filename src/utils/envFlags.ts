/** Shared parsing for boolean-ish env vars. */

export function isTruthy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function isFalsy(value: string | undefined): boolean {
	if (value === undefined) return false;
	const v = value.trim().toLowerCase();
	return v === "0" || v === "false" || v === "off" || v === "no";
}
