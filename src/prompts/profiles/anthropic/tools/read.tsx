import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const read: PromptModule = definePrompt(
	`Read the contents of a file. By default it reads the whole file, but large text files are
truncated to the first 2400 lines to save tokens. Use offset and limit to read a specific slice of
huge files. For image files up to 5 MB it returns the image directly for PNG, JPEG/JPG, WebP, GIF,
BMP, TIFF/TIF, AVIF, HEIC/HEIF, and ICO. Requires absolute file paths.

When you already know which part of a large file you need, read just that slice — it saves context.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | The absolute path to the file to read (must be absolute, not relative) |
| \`offset\` | \`number\` | no | The line number to start reading from (0-based, defaults to 0) |
| \`limit\` | \`number\` | no | The maximum number of lines to read (defaults to 2400) |`.trim(),
);
