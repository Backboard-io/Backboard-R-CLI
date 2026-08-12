import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const webSearch: PromptModule = definePrompt(
	buildWebSearchPrompt(),
	buildWebSearchPrompt,
);

function buildWebSearchPrompt(context: PromptContext = {}): string {
	const followUp = hasTool(context, "FetchUrl")
		? "\n- Use fetch_url afterwards to read a promising result in full."
		: "";
	return `Search the web and return result titles, URLs, and snippets.

Use it when the answer depends on information outside the workspace and your own knowledge may be stale: library documentation and versions, exact error messages, public APIs, recent changes, public repositories. Do not use it for things you can learn from the local codebase or work out yourself.
- Write specific queries: names, versions, the exact error text. For anything "latest" or "current", include the year from the environment block, not the year you assume.${followUp}`;
}
