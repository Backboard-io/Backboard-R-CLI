import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const grep: PromptModule = definePrompt(
	buildGrepPrompt(),
	buildGrepPrompt,
);

function buildGrepPrompt(context: PromptContext = {}): string {
	const routing = [
		hasTool(context, "Glob") ? "For filename patterns use glob." : "",
		hasTool(context, "Read")
			? "Once you know the exact file and range, use read."
			: "",
	]
		.filter(Boolean)
		.join(" ");
	return `Search file contents with ripgrep. output_mode "file_paths" (the default, fast) returns only the files that match; "content" returns the matching lines, optionally with context and line numbers.

Use it to find definitions, call sites, strings, configuration keys, or error text anywhere in the tree.${routing ? ` ${routing}` : ""}
- pattern is a regex; set fixed_string for literal tokens that contain metacharacters such as \`foo(\` or \`a?.b\`.
- Narrow with path, glob, or type; add context or line_numbers when the surrounding code matters; use head_limit to sample a very broad match instead of flooding the output.
- When exploring, run several independent searches in one message.`;
}
