import { detectCommandShell } from "../../utils/commandShell.ts";
import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const execute: PromptModule = definePrompt(
	buildExecutePrompt(),
	buildExecutePrompt,
);

function buildExecutePrompt(context: PromptContext = {}): string {
	return [
		`Run a shell command and return its exit code and output (truncated after 40,000 characters).

Use it for builds, tests, package managers, git, project scripts, and system inspection.${routing(context)}`,
		`Shell model:
- Every call starts a fresh shell. Directory changes, exported variables, and activated virtual environments do not carry over; chain setup and command with \`&&\` in one call, or invoke environment binaries directly (for example \`.venv/bin/python\`).
- ${shellLine(context)}
- Prefer the cwd parameter and absolute paths over \`cd\`. Quote paths that contain spaces or shell metacharacters.
- Nothing can answer an interactive prompt, so pass non-interactive flags and never use \`git -i\` style interactive modes.
- The default timeout is 90 seconds. Exit code 124 means the command was killed on timeout: raise \`timeout\` for legitimately long runs, otherwise narrow the command.`,
		`Long-running commands:
- Start servers, watchers, and long jobs with fireAndForget=true only when you have other useful work to do meanwhile. Note the PID and log path the tool prints, check the log or process directly when you need the result, and \`kill <pid>\` when you are done with it.
- Do not use \`sleep\` as a polling mechanism. If nothing else is pending, run the command in the foreground with an adequate timeout instead.`,
		`Safety:
- Know a command's side effects before you run it. Destructive commands (deleting beyond your own temporary files, \`git reset --hard\`, force pushes, \`sudo\`, system changes) require an explicit request from the user.
- When killing processes by pattern, make sure the pattern cannot match the kill command itself (for example \`pkill -f '[s]erver.js'\`).
- Git: inspect \`git status\` and the staged diff before a requested commit, stage files by name, and follow the repository's message style from \`git log\`. No amending, config changes, hook skipping, or pushing unless the user asked.`,
	].join("\n\n");
}

function routing(context: PromptContext): string {
	const tools = [
		hasTool(context, "Read") ? "read" : "",
		hasTool(context, "Grep") ? "grep" : "",
		hasTool(context, "Glob") ? "glob" : "",
		hasTool(context, "Edit") ? "edit" : "",
		hasTool(context, "ApplyPatch") ? "apply_patch" : "",
		hasTool(context, "Write") ? "write" : "",
	].filter(Boolean);
	if (tools.length === 0) return "";
	return ` For viewing, searching, and changing files use ${tools.join(", ")} rather than cat, grep, find, sed, or heredocs here; they cost less and their output is shaped for you.`;
}

function shellLine(context: PromptContext): string {
	const shell =
		context.commandShellKind && context.commandShellPath
			? { kind: context.commandShellKind, path: context.commandShellPath }
			: detectCommandShell();
	if (shell.kind === "posix") return "Commands run under POSIX sh.";
	return `Commands run under bash (${shell.path}), so bash syntax such as arrays and \`[[ ]]\` is available.`;
}
