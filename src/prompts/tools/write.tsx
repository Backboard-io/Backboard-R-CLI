import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const write: PromptModule = definePrompt(
	buildWritePrompt(),
	buildWritePrompt,
);

function buildWritePrompt(context: PromptContext = {}): string {
	const preferEdit = hasTool(context, "Edit")
		? " To change an existing file, use edit instead: it sends only the difference and cannot drop content you did not mean to touch."
		: "";
	return `Create a file, or replace an existing file's entire contents, with the text you provide. Missing parent directories are created.

Use it for new files and for deliberate full rewrites.${preferEdit} Create files only when the task needs them; do not add documentation or README files unless the user asked for them.`;
}
