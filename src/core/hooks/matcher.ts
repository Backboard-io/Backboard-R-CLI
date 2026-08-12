import { errorMessage } from "../../utils/errors.ts";
// Matcher semantics shared by the writer, loader, and runtime so they can't drift.

export function validateHookMatcher(matcher: string): string | null {
	if (matcher === "" || matcher === "*") return null;
	try {
		new RegExp(matcher);
		return null;
	} catch (err) {
		return `Invalid matcher regex: ${errorMessage(err)}`;
	}
}

export function normalizeMatcher(matcher?: string): string | undefined {
	if (matcher === undefined) return undefined;
	const trimmed = matcher.trim();
	if (trimmed === "" || trimmed === "*") return undefined;
	return trimmed;
}

export function matchesHook(
	matcher: string | undefined,
	value: string,
): boolean {
	if (!matcher || matcher === "*") return true;
	try {
		// Anchored: matcher "Edit" must not also match "MultiEdit"/"NotebookEdit".
		return new RegExp(`^(?:${matcher})$`).test(value);
	} catch {
		return false;
	}
}
