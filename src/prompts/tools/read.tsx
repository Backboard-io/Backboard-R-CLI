import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const read: PromptModule = definePrompt(
	buildReadPrompt(),
	buildReadPrompt,
);

function buildReadPrompt(context: PromptContext = {}): string {
	return `## Read

Reads file contents. For supported image files up to 5 MB, returns the actual image content for direct visual analysis.

### Use When

- You know the exact file path to inspect.${hasTool(context, "Grep") ? "\n- You need a focused slice of a large file after locating relevant lines with Grep." : ""}
- You need to verify surrounding code before editing.
- You need to view or analyze a local image file directly.

${doNotUseWhen(context)}

### Behavior

- Reads the whole file by default.
- Large text files are truncated to preserve context.
- Use offset and limit to read specific portions of huge files.
- For PNG, JPEG/JPG, WebP, GIF, BMP, TIFF/TIF, AVIF, HEIC/HEIF, and ICO files, returns image content instead of text.
- Requires absolute file paths.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The absolute path to the file to read (must be absolute, not relative) |
| \`offset\` | \`number\` | no | The line number to start reading from (0-based, defaults to 0) |
| \`limit\` | \`number\` | no | The maximum number of lines to read (defaults to 2400) |`.trim();
}

function doNotUseWhen(context: PromptContext): string {
	const lines = [
		hasTool(context, "Glob")
			? "- You need to discover files by name or extension. Use Glob."
			: "",
		hasTool(context, "Grep")
			? "- You need to search file contents. Use Grep."
			: "",
	].filter(Boolean);
	return lines.length > 0 ? `### Do Not Use When\n\n${lines.join("\n")}` : "";
}
