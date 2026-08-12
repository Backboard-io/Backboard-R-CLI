type Level = "debug" | "info" | "warn" | "error";

const ENABLED =
	process.env.BACKBOARD_DEBUG === "1" || process.env.BACKBOARD_DEBUG === "true";

/**
 * Writes to stderr only. Stdout is owned by the Ink renderer, so logging there
 * would corrupt the TUI. Disabled unless BACKBOARD_DEBUG is set.
 */
function emit(level: Level, args: unknown[]): void {
	if (!ENABLED) return;
	const ts = new Date().toISOString();
	process.stderr.write(`[${ts}] ${level.toUpperCase()} ${format(args)}\n`);
}

function format(args: unknown[]): string {
	return args
		.map((a) => (typeof a === "string" ? a : safeStringify(a)))
		.join(" ");
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

export const logger = {
	debug: (...args: unknown[]) => emit("debug", args),
	info: (...args: unknown[]) => emit("info", args),
	warn: (...args: unknown[]) => emit("warn", args),
	error: (...args: unknown[]) => emit("error", args),
};
