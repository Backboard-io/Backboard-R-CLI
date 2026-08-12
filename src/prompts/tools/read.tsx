import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const read: PromptModule = definePrompt(
	buildReadPrompt(),
	buildReadPrompt,
);

function buildReadPrompt(context: PromptContext = {}): string {
	const routing = [
		hasTool(context, "Glob") ? "find paths with glob" : "",
		hasTool(context, "Grep") ? "find text with grep" : "",
	].filter(Boolean);
	const routingLine =
		routing.length > 0
			? ` When you do not know the path yet, ${routing.join(" and ")} first.`
			: "";
	return `Read a file and return its text with line numbers. Files longer than 2400 lines are cut off; pass offset (0-based) and limit to read a specific slice. Image files up to 5 MB (png, jpg, webp, gif, bmp, tiff, avif, heic, ico) come back as images you can look at.

Use it when you know which file you need.${routingLine} Once you know where the relevant lines are, read just that slice, and read several files in one message when you need them all.`;
}
