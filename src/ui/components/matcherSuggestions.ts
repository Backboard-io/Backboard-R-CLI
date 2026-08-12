export const ALL_TOOLS_OPTION = "*";

export function activeSegment(value: string): string {
	const lastPipe = value.lastIndexOf("|");
	const segment = lastPipe === -1 ? value : value.slice(lastPipe + 1);
	return segment.trim();
}

export function filterSuggestions(
	value: string,
	toolNames: readonly string[],
): string[] {
	const segment = activeSegment(value).toLowerCase();
	const matches =
		segment === ""
			? [...toolNames]
			: toolNames.filter((name) => name.toLowerCase().includes(segment));
	return value.trim() === "" ? [ALL_TOOLS_OPTION, ...matches] : matches;
}

export function completeSegment(value: string, suggestion: string): string {
	const lastPipe = value.lastIndexOf("|");
	if (lastPipe === -1) return suggestion;
	return `${value.slice(0, lastPipe + 1)}${suggestion}`;
}
