import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const grep: PromptModule = definePrompt(
	buildGrepPrompt(),
	buildGrepPrompt,
);

function buildGrepPrompt(context: PromptContext = {}): string {
	return `## Grep

High-performance file content search using ripgrep.

### Use When

- You need to search inside files by literal text or regex.
- You need to locate definitions, call sites, logs, traces, or config keys.
- You need matching lines with context before reading or editing files.

${doNotUseWhen(context)}

### Search Strategy

- Start broad enough to avoid missing alternate spellings, then narrow.
- Prefer regex alternation for traces and behavioral logs, for example \`tool.*use|tool_not_used\` instead of only \`tool_use\`.
- Use file type and glob filters to control scope rather than hardcoding one path too early.${hasTool(context, "Read") ? '\n- Use output_mode="file_paths" when you only need candidate files, then Read the relevant files.' : ""}
- Use context or line_numbers for content investigations where surrounding code matters.

### Performance

- Make multiple speculative Grep calls in parallel when exploring unrelated patterns.
- Search from the narrowest safe directory, but avoid over-narrowing before you understand the code layout.

Supports ripgrep parameters:
- Pattern matching with regex support
- File type filtering with type
- Glob pattern filtering with glob
- Case-insensitive search with ignore_case
- Context lines with context_before, context_after, and context
- Line numbers with line_numbers
- Multiline mode with multiline
- Custom search directories with path

Output modes:
- file_paths: Returns only matching file paths
- content: Returns matching lines with optional context, line numbers, and formatting

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`pattern\` | \`string\` | yes | A search pattern to match in file contents. Can be a literal string or a regular expression. Supports ripgrep regex syntax. |
| \`path\` | \`string\` | no | Path to a file or directory to search in. If not specified, searches in the current working directory. |
| \`glob\` | \`string\` | no | Glob pattern to filter files. Example: "*.js" for JavaScript files. |
| \`output_mode\` | \`string enum: content, file_paths\` | no | "file_paths" returns only matching file paths, "content" returns matching lines with optional context and line numbers. |
| \`ignore_case\` | \`boolean\` | no | Perform case-insensitive matching. |
| \`type\` | \`string\` | no | Ripgrep file type filter. Examples: js, py, rust, cpp. |
| \`context_before\` | \`number\` | no | Number of lines to show before each match. Only works with output_mode="content". |
| \`context_after\` | \`number\` | no | Number of lines to show after each match. Only works with output_mode="content". |
| \`context\` | \`number\` | no | Number of lines to show before and after each match. Only works with output_mode="content". |
| \`line_numbers\` | \`boolean\` | no | Show line numbers in output. Only works with output_mode="content". |
| \`multiline\` | \`boolean\` | no | Enable multiline mode where . matches newlines and patterns can span lines. |`.trim();
}

function doNotUseWhen(context: PromptContext): string {
	const lines = [
		hasTool(context, "Glob")
			? "- You need to discover files by path only. Use Glob."
			: "",
		hasTool(context, "Read")
			? "- You already know the exact file path and line range. Use Read."
			: "",
		hasTool(context, "Execute")
			? "- You are tempted to run shell grep/find in Execute for repository search. Use this tool instead."
			: "",
	].filter(Boolean);
	return lines.length > 0 ? `### Do Not Use When\n\n${lines.join("\n")}` : "";
}
