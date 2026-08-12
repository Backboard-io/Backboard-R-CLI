import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const applyPatch: PromptModule = definePrompt(
	buildApplyPatchPrompt(),
	buildApplyPatchPrompt,
);

function buildApplyPatchPrompt(context: PromptContext = {}): string {
	return `Create, update, delete, and move files with one structured patch.

${usageGuidance(context)} Group related file operations into a single patch rather than many small ones; large multi-file, multiline changes are fully supported.

Patch format:
- Open with \`*** Begin Patch\` and close with \`*** End Patch\`.
- Create a file with \`*** Add File: <path>\`, then the new lines, each prefixed with \`+\`.
- Delete a file with \`*** Delete File: <path>\`.
- Modify a file with \`*** Update File: <path>\`, then one or more hunks. Hunk headers start with \`@@\` (optionally \`@@ <context>\`); context lines start with a space, removed lines with \`-\`, added lines with \`+\`.
- To rename while editing, put \`*** Move to: <path>\` right after the update header.
- Close a hunk with \`*** End of File\` when the matched lines sit at the very end of the file.
- Give each update hunk enough context to be unambiguous. A hunk of only added lines appends to the end of the file unless you anchor it with \`@@ <context>\`.
- The entire patch is validated before a single write, so a bad operation never lands halfway.

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
		: "Use this to create and edit files.";
}
