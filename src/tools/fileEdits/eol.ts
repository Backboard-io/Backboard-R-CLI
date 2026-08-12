export type Eol = "\n" | "\r\n" | "\r";

export interface LogicalLines {
	lines: string[];
	hasFinalNewline: boolean;
}

export function detectEol(content: string): Eol {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	const cr = content.indexOf("\r");
	if (crlf !== -1 && (lf === -1 || crlf <= lf) && (cr === -1 || crlf <= cr)) {
		return "\r\n";
	}
	if (cr !== -1 && (lf === -1 || cr < lf)) return "\r";
	return "\n";
}

export function normalizeTextToEol(text: string, eol: Eol): string {
	if (eol === "\n") return text;
	return text.replaceAll("\n", eol);
}

export function toLogicalLines(content: string): LogicalLines {
	const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
	const hasFinalNewline = normalized.endsWith("\n");
	const body = hasFinalNewline ? normalized.slice(0, -1) : normalized;
	return {
		lines: body === "" ? [] : body.split("\n"),
		hasFinalNewline,
	};
}

export function fromLogicalLines(
	lines: readonly string[],
	eol: Eol,
	hasFinalNewline: boolean,
): string {
	if (lines.length === 0) return hasFinalNewline ? eol : "";
	const body = lines.join(eol);
	return hasFinalNewline ? `${body}${eol}` : body;
}
