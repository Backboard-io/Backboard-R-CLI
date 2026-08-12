/**
 * Maps a file extension (including the leading dot) to an LSP `languageId`.
 * Only the languages we ship servers for need to be exhaustive; anything else
 * falls back to "plaintext" at the call site. Kept intentionally small and
 * data-only so adding a language is a one-line change.
 */
export const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "javascriptreact",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".hxx": "cpp",
	".sh": "shellscript",
	".bash": "shellscript",
	".json": "json",
	".jsonc": "jsonc",
	".yaml": "yaml",
	".yml": "yaml",
	".html": "html",
	".htm": "html",
	".tex": "latex",
	".r": "r",
	".sql": "sql",
};

export function languageIdForPath(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot < 0) return "plaintext";
	const ext = filePath.slice(dot).toLowerCase();
	return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}
