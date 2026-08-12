import type { Diagnostic } from "vscode-languageserver-types";

const MAX_PER_FILE = 20;

/**
 * Diagnostic codes suppressed from the model-visible edit-loop feedback.
 * pyright's import-resolution rules fire constantly in benchmark/sandbox
 * environments where a package is installed at runtime but not visible to the
 * static analyzer (e.g. sympy, matplotlib, torch). They are the loudest signal
 * in practice yet almost always false positives that waste edit turns; real
 * bugs (undefined names, syntax, type-contract breaks) still surface.
 */
const SUPPRESSED_CODES: ReadonlySet<string> = new Set([
	"reportMissingImports",
	"reportMissingModuleSource",
]);

function isSuppressed(diagnostic: Diagnostic): boolean {
	const code = diagnostic.code;
	return typeof code === "string" && SUPPRESSED_CODES.has(code);
}

const SEVERITY_LABEL: Record<number, string> = {
	1: "ERROR",
	2: "WARN",
	3: "INFO",
	4: "HINT",
};

/** One-line, human/model readable rendering of a single diagnostic. */
export function prettyDiagnostic(diagnostic: Diagnostic): string {
	const label = SEVERITY_LABEL[diagnostic.severity ?? 1] ?? "ERROR";
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const code =
		diagnostic.code !== undefined && diagnostic.code !== null
			? ` ${diagnostic.code}`
			: "";
	return `${label} [${line}:${col}]${code} ${diagnostic.message}`;
}

/**
 * Build the model-visible diagnostics block for a file. Only errors are
 * reported (warnings/info/hints are noise for the edit loop), capped per file.
 * Returns an empty string when there is nothing actionable.
 */
export function reportDiagnostics(
	file: string,
	diagnostics: Diagnostic[],
): string {
	const errors = diagnostics.filter(
		(d) => (d.severity ?? 1) === 1 && !isSuppressed(d),
	);
	if (errors.length === 0) return "";
	const shown = errors.slice(0, MAX_PER_FILE);
	const overflow = errors.length - shown.length;
	const suffix = overflow > 0 ? `\n... and ${overflow} more` : "";
	const body = shown.map(prettyDiagnostic).join("\n");
	return `<diagnostics file="${file}">\n${body}${suffix}\n</diagnostics>`;
}

export type { Diagnostic };
