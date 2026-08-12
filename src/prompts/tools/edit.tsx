import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const edit: PromptModule = definePrompt(
	buildEditPrompt(),
	buildEditPrompt,
);

function buildEditPrompt(context: PromptContext = {}): string {
	return `Edit a file by applying one or more exact find-and-replace operations.

Prefer batching all changes for one file in a single Edit call using the edits array.${hasTool(context, "Read") ? "\nMake sure the Read tool was called first before making edits." : ""}
Preserve the exact indentation (tabs or spaces).
${newFileGuidance(context)}
Each 'old_str' may span multiple lines and must match the file text exactly. If the file uses CRLF line endings, newline matches are handled for multiline edits.
Each 'old_str' must be unique in the file, or 'replace_all' must be true.
Provide larger 'old_str' values with surrounding context to narrow down the exact match.
All edits are matched against the same snapshot of the file (as last read) and applied atomically: either every edit applies or none do. Edits in one call must not overlap the same text.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file to edit |
| \`edits\` | \`array\` | yes | One or more edits, each with old_str, new_str, and optional replace_all, all matched against the same file snapshot |`.trim();
}

function newFileGuidance(context: PromptContext): string {
	if (hasTool(context, "Write")) {
		return "Never write a new file with this tool; use Write for full-file writes.";
	}
	if (hasTool(context, "ApplyPatch")) {
		return "Never write a new file with this tool; use ApplyPatch for file creation.";
	}
	return "Never write a new file with this tool.";
}
