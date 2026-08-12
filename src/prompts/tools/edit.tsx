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
	const readFirst = hasTool(context, "Read")
		? "- Read the file first so each old_str matches the current text exactly, indentation included; the tool rejects edits to a file you have not read."
		: "- Each old_str must match the current file text exactly, indentation included.";
	const create = hasTool(context, "Write")
		? "- It does not create files; use write for that."
		: hasTool(context, "ApplyPatch")
			? "- It does not create files; use apply_patch for that."
			: "- It does not create files.";
	return `Replace exact text in an existing file. Pass file_path and an edits array of { old_str, new_str, replace_all? }. Every edit is matched against the same snapshot of the file and the call is atomic: if one edit fails to match, nothing is written and the error names the edit that missed.

${readFirst}
- old_str must occur exactly once unless replace_all is true. If it is ambiguous, include more surrounding lines; use replace_all for renames.
- Put all the edits for one file in a single call; edits in the same call must not overlap.
${create}`;
}
