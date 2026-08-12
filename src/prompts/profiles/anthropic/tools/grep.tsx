import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const grep: PromptModule = definePrompt(
	`High-performance file-content search powered by ripgrep, exposing its full parameter set.

Supported ripgrep features:
- Regex pattern matching, or literal matching with fixed_string
- File-type filtering (--type js, --type py, etc.)
- Glob filtering (--glob "*.js")
- Case-insensitive search (-i)
- Context lines (-A, -B, -C for after/before/around)
- Line numbers (-n)
- Multiline mode (-U --multiline-dotall)
- Custom search directories

Output modes:
- file_paths: matching file paths only (default, fast)
- content: matching lines with optional context, line numbers, and formatting

When searching for code tokens that contain regex metacharacters — foo(, arr[i], a?.b — set fixed_string to true instead of hand-escaping the pattern.

Broad patterns can return thousands of lines; set head_limit when you only need to confirm existence or sample matches.

PERFORMANCE TIP: while exploring a codebase, fire several speculative grep calls in one response — different patterns, file types, or directories at once.

Returns results in the selected output mode.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`pattern\` | \`string\` | yes | A search pattern to match in file contents. Regex by default; literal when fixed_string is true. |
| \`path\` | \`string\` | no | Path to a file or directory to search in. If not specified, searches in the current working directory. |
| \`glob\` | \`string\` | no | Glob pattern to filter files. Example: "*.js" for JavaScript files. |
| \`output_mode\` | \`string enum: content, file_paths\` | no | "file_paths" returns only matching file paths, "content" returns matching lines with optional context and line numbers. |
| \`fixed_string\` | \`boolean\` | no | Treat the pattern as a literal string instead of a regex (ripgrep -F). Use for special characters like ?, *, (, [. |
| \`ignore_case\` | \`boolean\` | no | Perform case-insensitive matching. |
| \`type\` | \`string\` | no | Ripgrep file type filter. Examples: js, py, rust, cpp. |
| \`context_before\` | \`number\` | no | Number of lines to show before each match. Only works with output_mode="content". |
| \`context_after\` | \`number\` | no | Number of lines to show after each match. Only works with output_mode="content". |
| \`context\` | \`number\` | no | Number of lines to show before and after each match. Only works with output_mode="content". |
| \`line_numbers\` | \`boolean\` | no | Show line numbers in output. Only works with output_mode="content". |
| \`head_limit\` | \`number\` | no | Limit output to the first N lines. Works with both output modes. |
| \`multiline\` | \`boolean\` | no | Enable multiline mode where . matches newlines and patterns can span lines. |`.trim(),
);
