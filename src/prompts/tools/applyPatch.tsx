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
	const alternatives = [
		hasTool(context, "Write") ? "write" : "",
		hasTool(context, "Edit") ? "edit" : "",
	].filter(Boolean);
	const preference =
		alternatives.length > 0
			? `Prefer it over ${alternatives.join(" and ")} for source changes; `
			: "Use it for all source changes; ";
	return `Create, update, delete, and move files with one structured patch. The whole patch is validated before anything is written, so a bad hunk never lands halfway.

${preference}group related file operations into one patch rather than several small ones. Do not hand-write patches for generated files or bulk mechanical rewrites; run the generator or a script instead.

Format:
- Wrap the patch in \`*** Begin Patch\` and \`*** End Patch\`.
- \`*** Add File: <path>\` followed by the new content, every line prefixed with \`+\`.
- \`*** Delete File: <path>\`.
- \`*** Update File: <path>\` followed by one or more hunks. A hunk starts with \`@@\` (optionally \`@@ <anchor text>\` to pin an ambiguous location); inside it, context lines start with a space, removed lines with \`-\`, added lines with \`+\`.
- \`*** Move to: <path>\` directly under an Update header renames the file while editing it.
- \`*** End of File\` after a hunk when the matched lines are the last lines of the file.
- Give each hunk about three lines of context on each side, enough to match one place only. A hunk containing only \`+\` lines appends to the end of the file unless an \`@@ <anchor>\` places it.
- Paths are relative to the working directory.`;
}
