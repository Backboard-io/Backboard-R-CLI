import { canonicalToolName } from "./names.ts";

export function combineToolAllowlists(
	...lists: Array<readonly string[]>
): string[] {
	const restricted = lists.filter((list) => list.length > 0);
	if (restricted.length === 0) return [];
	const [first, ...rest] = restricted;
	if (!first) return [];
	return first
		.map(canonicalToolName)
		.filter((name) =>
			rest.every((list) => list.map(canonicalToolName).includes(name)),
		);
}

export function combineToolExclusions(
	...lists: Array<readonly string[]>
): string[] {
	return [...new Set(lists.flat().map(canonicalToolName))];
}

export function isAllowedByToolList(
	name: string,
	tools: readonly string[],
): boolean {
	const canonicalName = canonicalToolName(name);
	return (
		tools.length === 0 || tools.map(canonicalToolName).includes(canonicalName)
	);
}
