import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const glob: PromptModule = definePrompt(
	buildGlobPrompt(),
	buildGlobPrompt,
);

function buildGlobPrompt(context: PromptContext = {}): string {
	return `## Glob

Finds files by path using glob patterns. Uses ripgrep for fast file discovery.

### Use When

- You need to discover files before reading or editing them.
- You know a path shape, extension, or directory pattern.
- You want multiple candidate file sets in one call.

${doNotUseWhen(context)}

### Relationships

${relationships(context)}
- Prefer multiple patterns over repeated single-pattern calls when exploring.
- Use excludePatterns to skip node_modules, dist, build output, logs, and generated files.

Common patterns:
- "*.ext" - all files with extension
- "**/*.ext" - all files with extension in any subdirectory
- "dir/**/*" - all files under directory
- "{*.js,*.ts}" - multiple extensions
- "!node_modules/**" - exclude pattern, passed through excludePatterns

Provide either \`pattern\` or \`patterns\`.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`pattern\` | \`string\` | no | A single glob pattern to match file paths. Required if \`patterns\` is not provided. |
| \`patterns\` | \`array\` | no | Multiple glob patterns to match file paths. Required if \`pattern\` is not provided. |
| \`excludePatterns\` | \`array\` | no | Glob patterns to exclude from results. |
| \`path\` | \`string\` | no | Base directory to search in. If not specified, searches in the current working directory. |`.trim();
}

function doNotUseWhen(context: PromptContext): string {
	const lines = [
		hasTool(context, "Grep")
			? "- You need to search inside files. Use Grep."
			: "",
		hasTool(context, "Read")
			? "- You already know the exact file path. Use Read."
			: "",
	].filter(Boolean);
	return lines.length > 0 ? `### Do Not Use When\n\n${lines.join("\n")}` : "";
}

function relationships(context: PromptContext): string {
	return hasTool(context, "Read")
		? "- Pair Glob with Read: first find candidate files, then inspect the relevant ones."
		: "";
}
