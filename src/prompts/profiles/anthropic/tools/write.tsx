import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const write: PromptModule = definePrompt(
	buildWritePrompt(),
	buildWritePrompt,
);

function buildWritePrompt(context: PromptContext = {}): string {
	const preferEdit = hasTool(context, "Edit")
		? " Edit existing files instead; use this only to create a new one."
		: "";
	return `Create a new file with the given content.${preferEdit}

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file for the new file. |
| \`content\` | \`string\` | yes | The content to write to the file |`.trim();
}
