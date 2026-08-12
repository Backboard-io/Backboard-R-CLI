import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const create: PromptModule = definePrompt(
	`Creates a new file on the file system with the specified content. Prefer editing existing files, unless you need to create a new file.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The path to the file for the new file. |
| \`content\` | \`string\` | yes | The content to write to the file |`.trim(),
);
