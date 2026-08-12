export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1).trimEnd()}…`;
}

export function clipEnd(value: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (value.length <= maxWidth) return value;
	if (maxWidth <= 3) return value.slice(0, maxWidth);
	return `${value.slice(0, maxWidth - 3)}...`;
}

export function padColumn(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text.padEnd(width);
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

export function pluralize(
	count: number,
	singular: string,
	plural = `${singular}s`,
): string {
	return count === 1 ? singular : plural;
}

export function expandTabs(text: string, tabWidth = 4): string {
	if (!text.includes("\t")) return text;
	let result = "";
	for (const char of text) {
		if (char === "\t") {
			result += " ".repeat(tabWidth - (result.length % tabWidth));
		} else {
			result += char;
		}
	}
	return result;
}
