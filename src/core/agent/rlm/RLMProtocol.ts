export function extractCodeBlock(text: string): string | null {
	const match = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/);
	return match?.[1] !== undefined ? match[1].trim() : null;
}

export function extractReasoning(text: string): string {
	const code = text.match(/```(?:js|javascript)?\s*\n[\s\S]*?```/);
	if (code?.index === undefined) return text.trim();
	return text.slice(0, code.index).trim();
}
