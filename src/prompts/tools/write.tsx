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
	return `Write the full contents of a file.

Use this for new files or deliberate full-file rewrites.${hasTool(context, "Edit") ? " Prefer Edit for targeted changes to existing files." : ""}
The parent directory is created when needed. Existing files are overwritten.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file to write |
| \`content\` | \`string\` | yes | The complete file contents |`.trim();
}
