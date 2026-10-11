/** Shared validation for CLI flags, saved preferences, and todo allocations. */
export function isTimerSeconds(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
	);
}

export function parseTimerSeconds(
	flag: string | undefined,
	persisted?: number,
): number | undefined {
	if (flag === undefined) return persisted;
	const value = flag.trim().toLowerCase();
	if (value === "off" || value === "0") return undefined;
	const seconds = Number(value);
	if (!isTimerSeconds(seconds)) {
		throw new Error(
			'--timer must be a positive whole number of seconds (or "off").',
		);
	}
	return seconds;
}
