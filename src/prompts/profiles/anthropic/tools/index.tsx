import type { PromptModule } from "../../../PromptModule.ts";
import { agent } from "./agent.tsx";
import { applyPatch } from "./applyPatch.tsx";
import { askUser } from "./askUser.tsx";
import { browser } from "./browser.tsx";
import { computer } from "./computer.tsx";
import { edit } from "./edit.tsx";
import { execute } from "./execute.tsx";
import { fetchUrl } from "./fetchUrl.tsx";
import { glob } from "./glob.tsx";
import { grep } from "./grep.tsx";
import { read } from "./read.tsx";
import { todoWrite } from "./todoWrite.tsx";
import { webSearch } from "./webSearch.tsx";
import { write } from "./write.tsx";

/** Anthropic-profile tool prompts, keyed by canonical tool name. */
export const toolPrompts: Record<string, PromptModule> = {
	read,
	write,
	edit,
	apply_patch: applyPatch,
	execute,
	grep,
	glob,
	fetch_url: fetchUrl,
	web_search: webSearch,
	ask_user: askUser,
	todo_write: todoWrite,
	computer,
	browser,
	agent,
};
