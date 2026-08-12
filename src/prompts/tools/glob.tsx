import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const glob: PromptModule = definePrompt(
	buildGlobPrompt(),
	buildGlobPrompt,
);

function buildGlobPrompt(context: PromptContext = {}): string {
	const routing = [
		hasTool(context, "Grep") ? "To search inside files use grep." : "",
		hasTool(context, "Read") ? "When you already know the path, read it." : "",
	]
		.filter(Boolean)
		.join(" ");
	return `Find files by path pattern. patterns takes one or more globs combined with OR, for example ["src/**/*.ts"] or ["*.md", "docs/**/*.mdx"]; excludePatterns drops matches such as ["node_modules/**", "dist/**"]; path sets the base directory.

Use it to discover candidate files by name, extension, or directory shape before reading or editing them.${routing ? ` ${routing}` : ""} Pass several patterns, or make several calls in one message, when exploring.`;
}
