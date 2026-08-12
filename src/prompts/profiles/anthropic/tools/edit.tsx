import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const edit: PromptModule = definePrompt(
	buildEditPrompt(),
	buildEditPrompt,
);

function buildEditPrompt(context: PromptContext = {}): string {
	return `Edit a file by finding and replacing exact text.

${readFirst(context)}Each edit is an { old_str, new_str, replace_all? } object. Every 'old_str' is matched against the file as you last read it (one snapshot), and the call is atomic: either all edits apply or none do, and a failure names the edit that missed. You never have to predict intermediate file states.

Writing reliable edits:
- Give 'old_str' enough surrounding context to match exactly one place. If it appears more than once, either widen the context or set 'replace_all' to true (handy for renaming a variable).
- Keep the exact indentation (tabs or spaces) of the original.
- Bundle edits to one file into a single call when they are independent of each other; two edits in one call must not overlap the same text.
${newFileGuidance(context)}

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file to edit |
| \`edits\` | \`array\` | yes | One or more edits, each with old_str, new_str, and optional replace_all, all matched against the same file snapshot |`.trim();
}

function readFirst(context: PromptContext): string {
	return hasTool(context, "Read")
		? "Read the file first; this tool requires it.\n\n"
		: "";
}

function newFileGuidance(context: PromptContext): string {
	if (hasTool(context, "Write")) {
		return "- Never create a new file with this tool; use write for that.";
	}
	if (hasTool(context, "ApplyPatch")) {
		return "- Never create a new file with this tool; use apply_patch for that.";
	}
	return "- Never create a new file with this tool.";
}
