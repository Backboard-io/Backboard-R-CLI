import type { PromptModule } from "../../../PromptModule.ts";
import { agent } from "../../../tools/agent.tsx";
import { applyPatch } from "../../../tools/applyPatch.tsx";
import { askUser } from "../../../tools/askUser.tsx";
import { browser } from "../../../tools/browser.tsx";
import { computer } from "../../../tools/computer.tsx";
import { edit } from "../../../tools/edit.tsx";
import { execute } from "../../../tools/execute.tsx";
import { fetchUrl } from "../../../tools/fetchUrl.tsx";
import { glob } from "../../../tools/glob.tsx";
import { grep } from "../../../tools/grep.tsx";
import { read } from "../../../tools/read.tsx";
import { todoWrite } from "../../../tools/todoWrite.tsx";
import { webSearch } from "../../../tools/webSearch.tsx";
import { write } from "../../../tools/write.tsx";

/** Keyed by tool name so each tool reads its own model-facing description. */
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
