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
	return `## Execute

Execute a shell command with optional timeout in seconds.

### Use When

- You need to run tests, builds, package managers, git commands, or project scripts.
- You need OS-level inspection that no dedicated tool supports.
- You need to run a command whose side effects are intentional and understood.

${doNotUseWhen(context)}

CRITICAL: Each command runs in a NEW, ISOLATED shell process. Nothing persists between execute calls:
- Environment variables are reset
- Virtual environment activations are lost
- Working directory changes are lost
- Installed packages remain, but PATH changes are lost

${shellGuidance(context)}

Before executing commands:

1. Directory Verification:
${directoryVerification()}

2. Path Quoting:
   Always quote file paths that contain spaces or special characters like '(', ')', '[', ']' with double quotes:
   CORRECT:
   - cd "/Users/name/My Documents"
   - cd "/Users/project/(session)/routes"
   - python "/path/with spaces/script.py"
   - rm "/tmp/file (copy).txt"
   - ls "/path/with[brackets]/file.txt"

   INCORRECT (will fail):
   - cd /Users/name/My Documents
   - cd /Users/project/(session)/routes
   - python /path/with spaces/script.py
   - rm /tmp/file (copy).txt
   - ls /path/with[brackets]/file.txt

3. Working Directory Management:
   Prefer using absolute paths over changing directories:
   GOOD: pytest /project/tests
   BAD: cd /project && pytest tests

${toolUsageGuidelines(context)}

Python Package Management (CRITICAL):
Since each execute call runs in a NEW shell, you MUST chain all setup in one command!

WRONG (will fail):
- execute: source venv/bin/activate
- execute: pip install numpy  # FAILS - new shell doesn't have venv!

CORRECT approaches:
1. Direct venv usage (MOST RELIABLE):
   execute: venv/bin/python -m pip install numpy
   execute: .venv/bin/python script.py

2. Chain activation and command:
   execute: source venv/bin/activate && pip install numpy
   execute: source venv/bin/activate && python script.py

3. When pip is not found, try these IN ORDER:
   a) python3 -m pip install <package>
   b) python -m pip install <package>
   c) pip3 install <package>
   d) If "No module named pip": python3 -m ensurepip --default-pip && python3 -m pip install <package>

4. Check Python/pip availability:
   execute: python3 --version && python3 -m pip --version
   execute: which python3 || which python || echo "Python not found"

5. For conda environments:
   execute: conda activate myenv && pip install <package>
   execute: ~/miniconda3/envs/myenv/bin/python -m pip install <package>

Environment Variables & Virtual Environments:
- Environment variables do NOT persist between commands
- Virtual environment activations (venv, conda) must be done in each command
- Example: Instead of separate activation, use: "source venv/bin/activate && python script.py"
- Or directly use: "venv/bin/python script.py" (more reliable!)

Git Safety Guidelines:
- Always run 'git status' before other git commands
- Never use -i flag (interactive mode not supported)
- Never push without explicit user instruction
- Check changes with 'git diff' before committing
- Never update the git config unless user explicitly asks

Output Limits:
- Command output is truncated at 40,000 characters
- Long outputs will show truncation info

Security:
- NEVER run destructive commands like 'rm -rf /' or 'rm -rf ~'
- Be cautious with commands that modify system files
- Avoid running commands with sudo unless explicitly requested
- When killing processes by pattern, avoid plain \`pkill -f pattern\` matching its own command line; use a bracketed pattern like \`pkill -f '[p]attern'\` or kill explicit PIDs.

Timeout:
- Default: 90 seconds
- Commands that exceed timeout will be terminated
- Exit code 124 means execute timed out the command. If the command is expected to run longer, rerun it with a larger \`timeout\`; otherwise inspect partial output before retrying.
## Long-running commands and background jobs

Do not use \`sleep\` as a polling mechanism for background commands.

Bad:
- \`sleep 120 && cat /tmp/job.log\`
- repeatedly running \`sleep 60\`, then checking \`ps\`, \`tail\`, or logs
- choosing arbitrary sleep durations to wait for compilation, tests, training, downloads, or benchmarks

Instead:
1. If a command may take a long time, start it in the background only when you have useful independent work to do.
2. Record the PID and log path returned by the tool.
3. Continue with other useful tasks while the job runs.
4. When you need the result, check process status and logs directly.
5. If there is no useful independent work left, run the command in the foreground with an appropriate timeout rather than backgrounding it and sleeping.
6. If the environment provides job wait/status/notification tools, use those instead of shell sleeps.

# Committing changes with git

When the user asks you to create a new git commit, follow these steps carefully:

1. Run these commands IN PARALLEL to understand the current state:
   - git status (to see all untracked files)
   - git diff (to see staged and unstaged changes)
   - git log --oneline -10 (to see recent commit messages and follow the repo's style)

2. Analyze all changes and draft a commit message:
   - Summarize the nature of changes (new feature, enhancement, bug fix, refactoring, test, docs)
   - Check for any sensitive information that shouldn't be committed
   - Draft a concise (1-2 sentences) commit message focusing on "why" rather than "what"

3. Execute the commit:
   - Add relevant untracked files to staging area
   - Create the commit with an appropriate message
   - Run git status to confirm the commit succeeded

4. If the commit fails due to pre-commit hooks:
   - Retry ONCE to include automated changes
   - If it fails again, a pre-commit hook is likely preventing the commit
   - If files were modified by the pre-commit hook, amend your commit to include them

Important notes:
- Never update git config unless user explicitly asks
- Never use -i flag (interactive mode not supported)
- Don't push unless explicitly asked
- Don't create empty commits if there are no changes

# Creating pull requests

IMPORTANT: When the user asks you to create a pull request, follow these steps:

1. Run these commands IN PARALLEL to understand the branch state:
   - git status (to see all untracked files)
   - git diff (to see both staged and unstaged changes that will be committed)
   - git log (to see recent commit messages, so that you can follow this repository's commit message style)

2. Analyze ALL changes that will be included in the PR:
   - Look at ALL commits, not just the latest one
   - Understand the full scope of changes

3. Create the PR:
   - Create new branch if needed
   - Use the default branch (shown in the system info) as the base branch if the user didn't explicitly specify a base branch to use
   - Push to remote with -u flag if needed
   - Use gh pr create if available, otherwise provide instructions

Important:
- Never update git config unless user explicitly asks
- Return the PR URL when done

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`command\` | \`string\` | yes | The command to execute |
| \`cwd\` | \`string\` | no | Working directory, relative to the session cwd |
| \`timeout\` | \`number\` | no | Timeout in seconds (default: 90) |
| \`fireAndForget\` | \`boolean\` | no | Run command in background without waiting for completion. After start, note the printed PID and temp log path, check process status and logs directly, and stop the process later with \`kill <pid>\` if needed. |`.trim();
}

function doNotUseWhen(context: PromptContext): string {
	const lines = [
		hasTool(context, "Read")
			? "- You only need to read a known file. Use read."
			: "",
		hasTool(context, "Grep")
			? "- You need to search file contents. Use grep, not shell grep."
			: "",
		hasTool(context, "Glob")
			? "- You need to discover file paths. Use glob, not find."
			: "",
		mutationDoNotUseWhen(context),
	].filter(Boolean);
	return lines.length > 0
		? `### Do Not Use When

${lines.join("\n")}`
		: "";
}

function mutationDoNotUseWhen(context: PromptContext): string {
	const tools = mutationTools(context);
	return tools.length > 0
		? `- You need to create or edit files. Use ${tools.join("/")}.`
		: "";
}

function directoryVerification(): string {
	return "   - If creating new directories or files, first verify the parent directory exists.";
}

function toolUsageGuidelines(context: PromptContext): string {
	const lines = [
		hasTool(context, "Read")
			? "- Prefer read over cat, head, tail, sed, or awk for viewing files"
			: "",
		hasTool(context, "Write")
			? "- Prefer write for creating new files or full-file rewrites"
			: "",
		hasTool(context, "Edit")
			? "- Prefer edit for targeted file modifications"
			: "",
		hasTool(context, "ApplyPatch")
			? "- Prefer apply_patch for file modifications"
			: "",
		hasTool(context, "Grep") && hasTool(context, "Glob")
			? "- Prefer grep and glob for searching instead of shell grep or find"
			: "",
		hasTool(context, "Grep") && !hasTool(context, "Glob")
			? "- Prefer grep for searching file contents instead of shell grep"
			: "",
		!hasTool(context, "Grep") && hasTool(context, "Glob")
			? "- Prefer glob for discovering file paths instead of find"
			: "",
	].filter(Boolean);
	return lines.length > 0
		? `Tool Usage Guidelines:
${lines.join("\n")}`
		: "";
}

function shellGuidance(context: PromptContext): string {
	const shell =
		context.commandShellKind && context.commandShellPath
			? { kind: context.commandShellKind, path: context.commandShellPath }
			: detectCommandShell();
	if (shell.kind === "posix") {
		return "Shell: Commands run under POSIX `sh`.";
	}
	return `Shell: commands run under bash (${shell.path}). Bash features such as \`[[ ]]\`, arrays, and process substitution are available.`;
}

function mutationTools(context: PromptContext): string[] {
	return [
		hasTool(context, "Write") ? "write" : "",
		hasTool(context, "Edit") ? "edit" : "",
		hasTool(context, "ApplyPatch") ? "apply_patch" : "",
	].filter(Boolean);
}
