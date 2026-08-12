export function hasStructuralDiagnosticText(text: string): boolean {
	return DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text));
}

const DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
	/\bTraceback \(most recent call last\):/,
	/\bat .+:\d+:\d+\)?/,
	/\b\w+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp):\d+(?::\d+)?\b/,
	/\b(?:FAIL|FAILED|Error):\s+[^\n]+/,
	/\bexit code:\s*[1-9]\d*\b/i,
	/```[\s\S]{0,2000}\bexit code:\s*[1-9]\d*\b[\s\S]{0,2000}```/i,
];
