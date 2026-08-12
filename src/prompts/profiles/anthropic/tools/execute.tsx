import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const execute: PromptModule = definePrompt(
	buildExecutePrompt(),
	buildExecutePrompt,
);

function buildExecutePrompt(context: PromptContext = {}): string {
	return `Execute a shell command with an optional timeout (in seconds).

CRITICAL: Every Execute call runs in a brand-new, isolated shell. Nothing carries over between calls:
- Environment variables reset.
- Virtual environment activations are gone.
- Directory changes are gone.
- Installed packages stay, but PATH changes are gone.

Before you run a command:

1. Directory check:
${directoryVerification()}

2. Path quoting:
   Double-quote any file path containing spaces or special characters such as '(', ')', '[', ']'.
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

3. Working directory:
   Use absolute paths instead of changing directories:
   GOOD: pytest /project/tests
   BAD: cd /project && pytest tests

${toolUsageGuidelines(context)}

Python package management (CRITICAL):
Because each Execute starts a fresh shell, chain all setup into one command.

WRONG (will fail):
- Execute: source venv/bin/activate
- Execute: pip install numpy  # FAILS - the new shell has no venv!

CORRECT approaches:
1. Call the venv directly (MOST RELIABLE):
   Execute: venv/bin/python -m pip install numpy
   Execute: .venv/bin/python script.py

2. Chain activation with the command:
   Execute: source venv/bin/activate && pip install numpy
   Execute: source venv/bin/activate && python script.py

3. When pip is missing, try these IN ORDER:
   a) python3 -m pip install <package>
   b) python -m pip install <package>
   c) pip3 install <package>
   d) If "No module named pip": python3 -m ensurepip --default-pip && python3 -m pip install <package>

4. Check Python/pip availability:
   Execute: python3 --version && python3 -m pip --version
   Execute: which python3 || which python || echo "Python not found"

5. For conda environments:
   Execute: conda activate myenv && pip install <package>
   Execute: ~/miniconda3/envs/myenv/bin/python -m pip install <package>

Environment variables and virtual environments:
- Environment variables never survive between commands.
- Activate venv or conda inside every command that needs it.
- Instead of a separate activation, use: "source venv/bin/activate && python script.py".
- Better yet, call it directly: "venv/bin/python script.py".

Git safety:
- Run 'git status' before any other git command.
- Never use the -i flag; interactive mode is unsupported.
- Never push unless the user explicitly tells you to.
- Review changes with 'git diff' before committing.
- Never change git config unless the user explicitly asks.

Output limits:
- Output is truncated at 40,000 characters.
- Truncated output is marked as such.

Security:
- NEVER run destructive commands such as 'rm -rf /' or 'rm -rf ~'.
- Treat commands that touch system files with caution.
- Do not use sudo unless the user explicitly requests it.

Timeout:
- Defaults to 90 seconds.
- Any command past the timeout is killed.

Background processes (fireAndForget=true):
- The CLI prints the PID and log file path on start.
- Read logs after a delay in one command: \`sleep <s> && cat <file>\` (POSIX) or \`Start-Sleep <s>; Get-Content <file>\` (PowerShell). Use \`tail -n <N>\` or \`-Tail <N>\` for the last N lines.
- Check status: \`ps -p <pid>\` (POSIX) or \`Get-Process -Id <pid>\` (PowerShell).
- Terminate: \`kill <pid>\` (POSIX) or \`Stop-Process -Id <pid>\` (PowerShell).

# Committing changes with git

When the user asks for a new commit, follow these steps precisely:

1. Run these IN PARALLEL to read the current state:
   - git status (every untracked file)
   - git diff (staged and unstaged changes)
   - git log --oneline -10 (recent messages, to match the repo's style)

2. Review the changes and draft the message:
   - Classify the change (feature, enhancement, bug fix, refactor, test, docs).
   - Check for anything sensitive that must not be committed.
   - Write a 1-2 sentence message that explains "why", not "what".

3. Make the commit:
   - Stage the relevant untracked files.
   - Commit with your message.
   - Run git status to confirm it landed.

4. If a pre-commit hook fails the commit:
   - Retry ONCE to fold in automated changes.
   - If it fails again, a pre-commit hook is likely blocking it.
   - If the hook modified files, amend the commit to include them.

Always:
- Never change git config unless the user explicitly asks.
- Never use the -i flag; interactive mode is unsupported.
- Never push unless explicitly asked.
- Never create an empty commit when there are no changes.

# Creating pull requests

IMPORTANT: when the user asks for a pull request, follow these steps:

1. Run these IN PARALLEL to read the branch state:
   - git status (every untracked file)
   - git diff (staged and unstaged changes that will be committed)
   - git log (recent messages, to match the repo's style)

2. Review EVERY change going into the PR:
   - Look at all commits, not just the latest.
   - Understand the full scope.

3. Open the PR:
   - Create a new branch if needed.
   - Base it on the default branch (shown in system info) unless the user names a different base.
   - Push to the remote with -u if needed.
   - Use gh pr create when available; otherwise give the user instructions.

Always:
- Never change git config unless the user explicitly asks.
- Return the PR URL when done.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`command\` | \`string\` | yes | The command to execute |
| \`cwd\` | \`string\` | no | Working directory, relative to the session cwd |
| \`timeout\` | \`number\` | no | Timeout in seconds (default: 90) |
| \`fireAndForget\` | \`boolean\` | no | Run command in background without waiting for completion. After start, note the printed PID and temp log path, check process status and logs directly, and stop the process later with \`kill <pid>\` if needed. |`.trim();
}

function directoryVerification(): string {
	return "   - When creating new directories or files, first confirm the parent directory exists.";
}

function toolUsageGuidelines(context: PromptContext): string {
	const lines = [
		hasTool(context, "Read")
			? "- Use the 'read' tool to view files instead of cat, head, tail, sed, or awk."
			: "",
		hasTool(context, "Write")
			? "- Use the 'write' tool to create new files."
			: "",
		mutationGuideline(context),
		searchGuideline(context),
		"- When you need grep, call 'rg' (ripgrep); it is preinstalled and faster.",
		"- Do not wrap commands in 'bash -lc', 'zsh -lc', or 'sh -c'.",
	].filter(Boolean);
	return lines.length > 0 ? `Tool usage:\n${lines.join("\n")}` : "";
}

function mutationGuideline(context: PromptContext): string {
	if (hasTool(context, "Edit")) {
		return "- Use the 'edit' tool to modify files.";
	}
	if (hasTool(context, "ApplyPatch")) {
		return "- Use the 'apply_patch' tool to modify files.";
	}
	return "";
}

function searchGuideline(context: PromptContext): string {
	if (hasTool(context, "Grep") && hasTool(context, "Glob")) {
		return "- Use the 'grep' and 'glob' tools to search; never run grep or find commands.";
	}
	if (hasTool(context, "Grep")) {
		return "- Use the 'grep' tool to search file contents; never run grep commands.";
	}
	if (hasTool(context, "Glob")) {
		return "- Use the 'glob' tool to find files; never run find commands.";
	}
	return "";
}
