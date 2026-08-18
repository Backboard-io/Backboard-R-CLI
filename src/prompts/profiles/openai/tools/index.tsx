import { detectCommandShell } from "../../../../utils/commandShell.ts";
import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

const read = definePrompt(buildReadPrompt(), buildReadPrompt);
const write = definePrompt(buildWritePrompt(), buildWritePrompt);
const edit = definePrompt(buildEditPrompt(), buildEditPrompt);
const applyPatch = definePrompt(buildApplyPatchPrompt(), buildApplyPatchPrompt);
const execute = definePrompt(buildExecutePrompt(), buildExecutePrompt);
const grep = definePrompt(buildGrepPrompt(), buildGrepPrompt);
const glob = definePrompt(buildGlobPrompt(), buildGlobPrompt);
const fetchUrl = definePrompt(buildFetchUrlPrompt(), buildFetchUrlPrompt);
const webSearch = definePrompt(buildWebSearchPrompt());
const askUser = definePrompt(buildAskUserPrompt());
const todoWrite = definePrompt(buildTodoWritePrompt(), buildTodoWritePrompt);
const computer = definePrompt(buildComputerPrompt());
const browser = definePrompt(buildBrowserPrompt());
const agent = definePrompt(buildAgentPrompt());

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

function buildReadPrompt(context: PromptContext = {}): string {
	return `Read file content from an exact path.

Use this when you already know the file to inspect, need surrounding code before editing, need a targeted slice after search results, or need to view/analyze a local image file directly. Do not use it for path discovery${hasTool(context, "Glob") ? "; use glob for that" : ""}${hasTool(context, "Grep") ? ", or for content search; use grep for that" : ""}.

Behavior:
- Reads the full file unless offset or limit is provided.
- Large files may be truncated; reread a smaller range when needed.
- Use 0-based line offsets.
- For image files up to 5 MB, returns direct image content for PNG, JPEG/JPG, WebP, GIF, BMP, TIFF/TIF, AVIF, HEIC/HEIF, and ICO.
- Provide an absolute path.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | Absolute path to the file to read. |
| \`offset\` | \`number\` | no | 0-based starting line. |
| \`limit\` | \`number\` | no | Maximum number of lines to return. |`.trim();
}

function buildWritePrompt(context: PromptContext = {}): string {
	return `Write complete file contents.

Use this for new files or intentional full-file replacement.${hasTool(context, "Edit") ? " Prefer edit for small changes to existing files." : ""}${hasTool(context, "ApplyPatch") ? " Prefer apply_patch when you need a reviewable patch or multiple file operations." : ""}

Behavior:
- Creates missing parent directories when possible.
- Replaces the whole file if it already exists.
- Provide the final complete content, not a diff.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | Path of the file to write. |
| \`content\` | \`string\` | yes | Complete file content. |`.trim();
}

function buildEditPrompt(context: PromptContext = {}): string {
	return `Apply exact find-and-replace edits to an existing file.

Use this for targeted changes when the current text is known.${hasTool(context, "Read") ? " Read the file first so old_str values match current content." : ""}

Rules:
- Batch all edits for the same file in one call when practical.
- Preserve existing indentation, line endings, and surrounding style.
- Each old_str must match exactly and be unique unless replace_all is intended.
- Use enough surrounding context in old_str to avoid replacing the wrong occurrence.
- Edits are validated before the file is written.
- Do not use this to create a new file${hasTool(context, "Write") ? "; use write" : hasTool(context, "ApplyPatch") ? "; use apply_patch" : ""}.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`file_path\` | \`string\` | yes | Path to the file to edit. |
| \`edits\` | \`array\` | yes | Ordered edits with old_str, new_str, and optional replace_all. |`.trim();
}

function buildApplyPatchPrompt(context: PromptContext = {}): string {
	return `Apply a structured patch for file creation, deletion, moves, or edits.

Prefer this for manual source changes when available, especially multi-file edits or changes that should be easy to review. Use generated tooling instead for formatter output or build artifacts.

Patch syntax:
- Start with \`*** Begin Patch\` and end with \`*** End Patch\`.
- Create files with \`*** Add File: <path>\` and prefix each content line with \`+\`.
- Delete files with \`*** Delete File: <path>\`.
- Update files with \`*** Update File: <path>\` followed by hunks.
- Hunk lines use a leading space for context, \`-\` for removal, and \`+\` for addition.
- Move a file by placing \`*** Move to: <path>\` immediately after the update header.
- Include enough context to identify the exact location.
- A patch validates before writing, so failed patches do not partially apply.

Tool relationship:
${mutationAlternatives(context)}

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`patch\` | \`string\` | yes | Complete patch text. |`.trim();
}

function buildExecutePrompt(context: PromptContext = {}): string {
	return `Run a shell command with an optional timeout.

Use this for tests, builds, package managers, git, project scripts, and OS-level checks that no dedicated tool handles. Avoid it for reading files, listing directories, searching code, or editing files when specialized tools are available.

Shell model:
- Each call starts a new isolated shell; working directory changes, exports, aliases, and virtualenv activation do not persist.
- ${shellDescription(context)}
- Use the cwd parameter instead of relying on \`cd\` when possible.
- Quote paths containing spaces or shell metacharacters.
- Chain setup and command in the same call when environment activation is needed.

Safety:
- Understand side effects before running a command.
- Never run destructive commands, broad deletion, forced git reset/checkout, or sudo unless explicitly requested and safe.
- Use non-interactive commands only; avoid flags or tools that require a prompt.
- Before git commit or push, inspect status and staged diff and check for secrets.
- Do not update git config, amend commits, or push unless explicitly requested.
- When killing processes, target explicit PIDs or use patterns that cannot match the kill command itself.

Validation workflow:
- Discover scripts from project files before inventing commands.
- Prefer focused checks during iteration and the strongest practical relevant check before final response.
- If a command times out, inspect partial output and decide whether a longer timeout or narrower check is safer.

Output:
- Command output may be truncated; rerun narrower commands when needed.
- Default timeout is 90 seconds.

Long-running commands and background jobs:
- Do not use \`sleep\` as a polling mechanism for background commands.
- Bad: \`sleep 120 && cat /tmp/job.log\`; repeated \`sleep 60\` followed by \`ps\`, \`tail\`, or log checks; arbitrary sleeps for compilation, tests, training, downloads, or benchmarks.
- If a command may take a long time, use fireAndForget only when you have useful independent work to do. Record the returned PID and temp log path, continue other work, then check process status and logs directly when you need the result.
- If no useful independent work remains, run the command in the foreground with an appropriate timeout instead of backgrounding it and sleeping.
- If the environment provides job wait/status/notification tools, use those instead of shell sleeps.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`command\` | \`string\` | yes | Shell command to run. |
| \`cwd\` | \`string\` | no | Working directory, relative to the session cwd. |
| \`timeout\` | \`number\` | no | Timeout in seconds. |
| \`fireAndForget\` | \`boolean\` | no | Run command in background without waiting for completion. After start, note the printed PID and temp log path, check process status and logs directly, and stop the process later with \`kill <pid>\` if needed. |`.trim();
}

function buildGrepPrompt(context: PromptContext = {}): string {
	return `Search file contents with ripgrep.

Use this to find definitions, call sites, strings, logs, config keys, error messages, or behavior traces. Do not use it only to discover paths${hasTool(context, "Glob") ? "; use glob for path discovery" : ""}${hasTool(context, "Read") ? ", or when you already know the exact file range; use read" : ""}.

Search strategy:
- Start with a broad but meaningful pattern, then narrow.
- Include alternate spellings with regex when names may vary.
- Scope by path, glob, or file type to avoid noisy output.
- Use context and line numbers when the surrounding code matters.
- Use output_mode \`file_paths\` when you only need candidate files.

Performance:
- Run independent searches in parallel when useful.
- Exclude generated or dependency directories through path or glob filters.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`pattern\` | \`string\` | yes | Literal or regex pattern using ripgrep syntax. |
| \`path\` | \`string\` | no | File or directory to search. Defaults to current working directory. |
| \`glob\` | \`string\` | no | Glob filter for searched files. |
| \`output_mode\` | \`string enum: content, file_paths\` | no | Return matching lines or only file paths. |
| \`ignore_case\` | \`boolean\` | no | Case-insensitive matching. |
| \`type\` | \`string\` | no | Ripgrep file type filter, such as js, py, rust, or cpp. |
| \`context_before\` | \`number\` | no | Lines before each match. |
| \`context_after\` | \`number\` | no | Lines after each match. |
| \`context\` | \`number\` | no | Lines before and after each match. |
| \`line_numbers\` | \`boolean\` | no | Include line numbers for content output. |
| \`multiline\` | \`boolean\` | no | Allow patterns to span newlines. |`.trim();
}

function buildGlobPrompt(context: PromptContext = {}): string {
	return `Discover files by path using glob patterns.

Use this when you need candidate files before reading or editing, know an extension or directory shape, or want to collect multiple path sets. Do not use it to search file contents${hasTool(context, "Grep") ? "; use grep" : ""}.

Guidance:
- Use patterns such as \`**/*.ts\`, \`src/**/*\`, or \`{*.js,*.ts}\`.
- Pass multiple patterns together when they are independent.
- Use excludePatterns for dependencies, build outputs, caches, logs, and generated files.
- Pair with read after selecting relevant candidates.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`pattern\` | \`string\` | no | Single glob pattern. Required if patterns is omitted. |
| \`patterns\` | \`array\` | no | Multiple glob patterns. Required if pattern is omitted. |
| \`excludePatterns\` | \`array\` | no | Glob patterns to exclude. |
| \`path\` | \`string\` | no | Base directory. Defaults to current working directory. |`.trim();
}

function buildFetchUrlPrompt(context: PromptContext = {}): string {
	return `Fetch raw content from an HTTP or HTTPS URL that the user explicitly provided.

Use this for reading a specific public page, document, or integration URL. Do not use it for web search${hasTool(context, "WebSearch") ? "; use web_search" : ""}, private network targets, local files, or URLs not supplied by the user.

Before fetching:
- Confirm the protocol is http or https.
- Reject localhost, loopback addresses, private IP ranges, file URLs, ssh/ftp schemes, and browser-only schemes.
- Reject malformed URLs, temporary session-token links, API endpoints that require non-GET methods, and corporate/internal infrastructure.
- If the user provides multiple valid URLs, fetch them in parallel when useful.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`url\` | \`string\` | yes | URL to fetch. |`.trim();
}

function buildWebSearchPrompt(): string {
	return `Search the web for current or external public information.

Use this when local context is insufficient and the answer depends on recent facts, public documentation, published references, current APIs, companies, organizations, people, public repositories, or trends. Do not use it for purely local codebase discovery, creative writing, ordinary reasoning, or math.

Guidance:
- Write specific queries with key names, versions, errors, or domains.
- Prefer official sources and primary references when available.
- Use fetch_url afterward when a specific result needs detailed reading.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`query\` | \`string\` | yes | Search query. |
| \`max_results\` | \`number\` | no | Maximum results, default 8 and maximum 20. |`.trim();
}

function buildAskUserPrompt(): string {
	return `Ask the user one or more focused multiple-choice clarification questions.

Use this only when the answer materially changes the result and cannot be safely inferred from context. Do all safe non-blocked work first.

Guidance:
- Batch related decisions into a single call: pass several \`questions\` the user would naturally settle together rather than interrupting repeatedly. Put the most load-bearing question first.
- Give each question a short \`header\` (2-4 words) — headers form a breadcrumb across the top so the user can see and jump between the whole set.
- Keep each question short, specific, and actionable, with clear option labels. The user can always type a custom answer, so do not add an "other" option.
- Include enough context in the question text for the user to understand the tradeoff.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`questions\` | \`array\` | yes | 1-4 related questions to ask together. |
| \`questions[].header\` | \`string\` | yes | Short title (2-4 words) shown in the breadcrumb. |
| \`questions[].question\` | \`string\` | yes | Question to present. |
| \`questions[].options\` | \`array\` | yes | 1-4 mutually exclusive options (2-4 recommended). |`.trim();
}

function buildTodoWritePrompt(context: PromptContext = {}): string {
	return `Maintain a visible todo list for non-trivial work.

Use this when work needs 3+ tool calls, the user gives multiple tasks, or new instructions arrive; skip it when 1-2 tool calls suffice or the request is purely conversational. Track only tasks the user actually gave, never ones inferred from system context or environment output.

Rules:
- Maximum 50 items; each item must be under 500 characters.
- Each item is an object with content and status.
- Status is one of pending, in_progress, or completed.
- Keep exactly one in_progress item while work is active and pending items remain.
- Mark a task in_progress before starting it; mark completed immediately after finishing, never in advance or in batches.
- Mark an item completed only after it is actually done and verified - never while tests fail, work is partial, or errors are unresolved.
- If blocked, keep the item in_progress and add an item for the blocker.
- Capture user-provided commands verbatim, with all flags and order preserved.
- Remove obsolete items rather than preserving stale plans.
- When all work is done and only a waiting-for-user item remains, mark it in_progress or remove the list.
${parallelTodoTip(context)}

Input shape:
\`{ "todos": [{ "content": "Inspect project structure", "status": "in_progress" }] }\`

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`todos\` | \`array\` | yes | Full updated todo list. |`.trim();
}

function buildComputerPrompt(): string {
	return `Control the local computer through screenshots and direct actions.

Use this only when GUI interaction is required. Prefer element IDs from fresh screenshots; use coordinates only as a fallback.

Safety:
- Take or rely on a fresh screenshot before acting.
- Inspect the result after state-changing actions.
- Ask the user before submitting forms, purchasing, deleting, entering credentials, or changing sensitive settings.
- Queue only the actions needed for the immediate step.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`actions\` | \`array\` | yes | Queue of 1-20 computer actions. |
| \`defaultDelayMs\` | \`number\` | no | Delay between actions. |
| \`stopOnError\` | \`boolean\` | no | Stop after the first failed action. |

Actions: screenshot, click, type, key, wait, openApp.`.trim();
}

function buildBrowserPrompt(): string {
	return `Automate a Chromium browser tab through screenshots and direct page actions.

Use navigate for URLs instead of typing into the address bar. Prefer element IDs from fresh screenshots; use coordinates only as a fallback.

Safety:
- Take or rely on a fresh screenshot before clicking.
- Inspect the result after state-changing actions.
- Ask the user before submitting forms, purchasing, deleting, entering credentials, or changing sensitive settings.
- Queue only the actions needed for the immediate step.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`actions\` | \`array\` | yes | Queue of 1-20 browser actions. |
| \`defaultDelayMs\` | \`number\` | no | Delay between actions. |
| \`stopOnError\` | \`boolean\` | no | Stop after the first failed action. |

Actions: screenshot, navigate, click, type, key, wait.`.trim();
}

function buildAgentPrompt(): string {
	return `Delegate an isolated investigation or analysis task to a sub-agent.

Use this when parallel exploration would save time, the question is broad enough to isolate, or a large input needs distillation. The sub-agent returns only a final report; its intermediate steps are not visible to the user.

Prompt requirements:
- State the goal and repository context.
- Include relevant paths, commands, links, and constraints.
- Say whether the sub-agent should only research or may edit code.
- Ask for a specific output format, such as findings with file paths, a checklist, or a patch summary.
- Do not depend on the sub-agent asking the user questions.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`subagent_type\` | \`string\` | no | Which agent to run; see "Available agents" below. Defaults to worker, which uses tools. An rlm agent instead analyzes structured inputs in a JavaScript REPL and must finish with SUBMIT(answer). |
| \`prompt\` | \`string\` | yes | Complete delegated task. |
| \`variables\` | \`object\` | no | Structured inputs for rlm sub-agents. |
| \`timeout_ms\` | \`number\` | no | Wall-clock budget in milliseconds. |`.trim();
}

function mutationAlternatives(context: PromptContext): string {
	const alternatives = [
		hasTool(context, "Write") ? "write is best for complete file contents" : "",
		hasTool(context, "Edit")
			? "edit is best for exact targeted replacements"
			: "",
	].filter(Boolean);

	return alternatives.length > 0
		? `- ${alternatives.join(".\n- ")}.`
		: "- Use the safest available file-editing tool for the change.";
}

function shellDescription(context: PromptContext): string {
	const shell =
		context.commandShellKind && context.commandShellPath
			? { kind: context.commandShellKind, path: context.commandShellPath }
			: detectCommandShell();

	if (shell.kind === "posix") return "Commands run under POSIX sh.";
	return `Commands run under bash (${shell.path}); bash syntax such as arrays and [[ ]] is available.`;
}

function parallelTodoTip(context: PromptContext): string {
	const tools = ["Read", "Grep", "Glob", "Execute"].filter((tool) =>
		hasTool(context, tool),
	);

	return tools.length > 0
		? `\n- When starting substantial work, todo_write can run in parallel with independent calls such as ${tools.join(", ")} if there is no write conflict.`
		: "";
}
