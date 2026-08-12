import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const applyPatch: PromptModule = definePrompt(
	buildApplyPatchPrompt(),
	buildApplyPatchPrompt,
);

function buildApplyPatchPrompt(context: PromptContext = {}): string {
	return `Apply a structured patch to create or update files.

${usageGuidance(context)} Prefer one patch with multiple file operations over many small patches. Large patches and multiline changes are supported.

Patch format:
- Start with \`*** Begin Patch\` and end with \`*** End Patch\`.
- To create a file, use \`*** Add File: <path>\`, followed by lines prefixed with \`+\`.
- To delete a file, use \`*** Delete File: <path>\`.
- To update a file, use \`*** Update File: <path>\`, then one or more hunks. Hunk headers start with \`@@\` or \`@@ <context>\`; context lines start with a space, removed lines with \`-\`, and added lines with \`+\`.
- To move a file while updating it, put \`*** Move to: <path>\` immediately after the update header.
- Use \`*** End of File\` after a hunk when the old lines should match at the end of the file.
- Include enough context in update hunks to identify the intended location. If an update hunk contains only added lines, the lines are appended to the end of the file unless an \`@@ <context>\` anchor is used.
- The patch is validated before files are written, so an invalid operation does not partially apply.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`patch\` | \`string\` | yes | The complete patch text to apply |`.trim();
}

function usageGuidance(context: PromptContext): string {
	const alternatives = [
		hasTool(context, "Write") ? "Write" : "",
		hasTool(context, "Edit") ? "Edit" : "",
	].filter(Boolean);
	return alternatives.length > 0
		? `Use this instead of ${alternatives.join("/")} when it is available.`
		: "Use this for file creation and edits.";
}
