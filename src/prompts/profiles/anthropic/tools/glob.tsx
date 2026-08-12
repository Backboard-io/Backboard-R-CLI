import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const glob: PromptModule = definePrompt(
	buildGlobPrompt(),
	buildGlobPrompt,
);

function buildGlobPrompt(context: PromptContext = {}): string {
	return `High-performance file-path search using glob patterns, powered by ripgrep.

Common patterns:
- "*.ext" - files with an extension
- "**/*.ext" - that extension in any subdirectory
- "dir/**/*" - everything under a directory
- "{*.js,*.ts}" - multiple extensions

PERFORMANCE TIP: while discovering files for a task, fire several speculative glob calls in one response — different file types or directories at once.

Returns the matching file paths.
${globVsExecute(context)}
### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`patterns\` | \`array\` | yes | One or more glob patterns combined with OR logic. Examples: ["*.ts"], ["src/**/*.tsx", "src/**/*.css"] |
| \`excludePatterns\` | \`array\` | no | Glob patterns to exclude from results, e.g. ["node_modules/**", "dist/**"] |
| \`path\` | \`string\` | no | Base directory to search in. If not specified, searches in the current working directory. |`.trim();
}

function globVsExecute(context: PromptContext): string {
	return hasTool(context, "Execute")
		? "\nNever run a glob command through execute; use this glob tool instead. It is faster and handles multiple patterns and exclusions.\n"
		: "";
}
