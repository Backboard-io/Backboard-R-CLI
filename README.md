# Backboard R-CLI

Backboard R-CLI is an AI coding agent that runs in your terminal. Open it in a
project and describe what you want to accomplish. It can inspect and edit files,
run commands, search the web, use MCP servers and skills, and keep its work
reviewable through permissions and checkpoints.

This directory contains the TypeScript implementation of the CLI. End users
should install the precompiled `backboard` binary. Contributors can run or
compile it from source with [Bun](https://bun.sh/).

## Documentation

This README covers installation, authentication, first use, and development.
The maintained product guides contain the complete feature reference:

- [R-CLI overview](https://docs.backboard.io/cli/overview)
- [Command and configuration reference](https://docs.backboard.io/cli/reference)
- [Permissions](https://docs.backboard.io/cli/permissions)
- [Checkpoints](https://docs.backboard.io/cli/checkpoints)
- [Session settings](https://docs.backboard.io/cli/settings)
- [Skills and discovery](https://docs.backboard.io/cli/skills)
- [MCP servers and hooks](https://docs.backboard.io/cli/mcp)
- [Attachments](https://docs.backboard.io/cli/attachments)
- [Backboard API documentation](https://docs.backboard.io/)

## Install the CLI

The production installer downloads a native binary for your operating system.
You do not need Bun, Node.js, or Python to use an installed binary.

### macOS and Linux

```sh
curl -fsSL https://app.backboard.io/api/cli | sh
```

The installer places the binary at:

```text
~/.backboard/bin/backboard
```

It also adds that directory to the appropriate shell startup file. Open a new
terminal if `backboard` is not immediately available.

If you prefer to inspect remote scripts before executing them:

```sh
curl -fsSL https://app.backboard.io/api/cli -o /tmp/backboard-install.sh
less /tmp/backboard-install.sh
sh /tmp/backboard-install.sh
```

### Windows PowerShell

```powershell
irm https://app.backboard.io/api/cli/windows | iex
```

The installer places `backboard.exe` in:

```text
%USERPROFILE%\.backboard\bin
```

It adds that directory to your user `Path`. Open a new PowerShell or terminal
window after installation.

### Verify the installation

```sh
backboard --version
backboard --help
```

R-CLI checks for updates in the background. Run `/update` inside the CLI to
check on demand and display the current upgrade command.

## Sign in with Backboard

The normal setup uses Backboard SSO through the OAuth 2.0 device authorization
flow:

```sh
backboard login
```

The CLI prints a verification URL and short code. On an interactive desktop it
also tries to open the browser automatically.

1. Open the displayed URL, or scan the QR code.
2. Sign in to or create your Backboard account.
3. Approve the device.
4. Return to the terminal.

The URL and code always remain available, so login also works over SSH or from
a terminal without a local browser. Open the URL on any device and enter the
shown code.

The CLI includes Backboard's first-party public OAuth client ID. Users do not
need to create an OAuth application, configure a client secret, or edit an
environment file.

Credentials are saved with restrictive permissions in:

```text
~/.backboard/config.json
```

You can also sign in from the fresh-install authentication screen or run
`/login` inside an interactive session.

To sign out:

```sh
backboard logout
```

Or use `/logout` inside R-CLI.

> If `BACKBOARD_API_KEY` is exported in your shell, it takes precedence over
> the saved login. `backboard logout` removes the saved credential but cannot
> unset a parent shell variable. Run `unset BACKBOARD_API_KEY` yourself if
> needed.

For the complete first-session walkthrough, see the
[R-CLI overview](https://docs.backboard.io/cli/overview). If you are building
Backboard SSO into a separate application, see the
[Backboard SSO integration guide](https://docs.backboard.io/concepts/sso).

## Use your own model-provider keys

A Backboard login is not required when you want to call a supported provider
directly. On the authentication screen choose **Bring your own key**, or run:

```text
/keys
```

R-CLI currently supports direct keys for:

- Anthropic
- OpenAI
- Google
- OpenRouter

Provider keys are validated before saving, encrypted at rest in
`~/.backboard/keys.json`, and never written to project session logs. Add keys
through the interactive flow rather than placing provider secrets in project
files.

You can keep both a Backboard login and provider keys. When the same provider
is available through both, the enabled direct key takes precedence for that
provider's models.

## Start your first session

Run `backboard` from the project you want it to work on:

```sh
cd /path/to/your/project
backboard
```

Or point it at a project explicitly:

```sh
backboard --cwd /path/to/your/project
```

Then enter a normal request:

```text
Explain how authentication works in this repository.
```

For implementation work, state the outcome and constraints:

```text
Fix the login redirect bug, add a regression test, and do not change the API.
```

R-CLI does not require git, but using it is strongly recommended:

```sh
git status
git diff
```

Every turn also records a local checkpoint. Use `/undo`, `/redo`, or `/rewind`
to restore changes. See the [checkpoints guide](https://docs.backboard.io/cli/checkpoints)
for details and limitations.

## Permissions and safe use

R-CLI starts in `manual` permission mode. Read-only operations may run
automatically; edits, writes, and non-trivial commands ask before running.

Press `Shift+Tab` to cycle interactive permission modes, or choose one at
startup:

```sh
backboard --permission-mode acceptEdits
```

Use `bypass` only in a disposable environment:

```sh
backboard --permission-mode bypass
```

Project permission rules live in:

```text
<repo-root>/.backboard/settings.json
```

Read the [permissions guide](https://docs.backboard.io/cli/permissions) before
using R-CLI in automation or relaxing its defaults.

## One-shot and JSON modes

Run one prompt and exit:

```sh
backboard --print "summarize this repository"
```

Run against another directory:

```sh
backboard --cwd /path/to/project --print "find untested error paths"
```

Produce newline-delimited JSON events for another program:

```sh
backboard --format json --print "summarize this repository"
```

You can also pipe a prompt into JSON mode:

```sh
printf '%s\n' "summarize this repository" | backboard --format json
```

One-shot mode cannot show interactive permission prompts. Calls that would ask
are denied unless an explicit project rule allows them or you deliberately use
`--permission-mode bypass`. See
[headless and automation](https://docs.backboard.io/cli/permissions#headless-and-automation).

## Common interactive commands

Type `/help` inside R-CLI for the authoritative command list.

| Command                     | Purpose                                    |
| --------------------------- | ------------------------------------------ |
| `/model`                    | Choose a model and thinking mode           |
| `/settings`                 | Adjust session preferences                 |
| `/keys`                     | Manage direct provider API keys            |
| `/sessions`                 | Resume a Backboard or local BYOK session   |
| `/context`                  | Inspect context-window usage               |
| `/compress`                 | Compress the current conversation          |
| `/undo`, `/redo`, `/rewind` | Restore checkpointed file changes          |
| `/skills`                   | Browse and load skills                     |
| `/mcp`                      | Manage MCP servers                         |
| `/hooks`                    | Manage command hooks                       |
| `/browser`                  | Enable browser automation for this session |
| `/cua`                      | Enable local computer use for this session |
| `/lsp`                      | Toggle language-server diagnostics         |
| `/new`                      | Start a new thread                         |
| `/update`                   | Check for a newer CLI release              |
| `/login`, `/logout`         | Change Backboard authentication            |
| `/quit`                     | Exit the CLI                               |

See the [command reference](https://docs.backboard.io/cli/reference) for every
command, alias, startup flag, and keyboard shortcut.

## Local files and configuration

R-CLI keeps user credentials separate from project state.

| Path                                   | Purpose                                           |
| -------------------------------------- | ------------------------------------------------- |
| `~/.backboard/config.json`             | Backboard credential and saved preferences        |
| `~/.backboard/keys.json`               | Encrypted direct provider keys                    |
| `~/.backboard/mcp.json`                | Personal MCP servers and secrets                  |
| `~/.backboard/hooks.json`              | Personal command hooks                            |
| `<repo-root>/.backboard/settings.json` | Project permission policy                         |
| `<repo-root>/.backboard/mcp.json`      | Shareable project MCP configuration               |
| `<repo-root>/.backboard/hooks.json`    | Shareable project hook configuration              |
| `<repo-root>/.backboard/agents/`       | Shareable project sub-agent definitions           |
| `~/.backboard/agents/`                 | Personal sub-agent definitions                    |
| `<cwd>/.backboard/sessions/`           | Session logs, BYOK conversations, and checkpoints |
| `<cwd>/.agents/skills/`                | Project skills                                    |
| `~/.agents/skills/`                    | Personal skills                                   |

Project MCP and hook files can execute local commands. Review them before
running an unfamiliar repository. Keep secrets in user-level files or
environment variables, not committed project configuration.

Session state is stored relative to the working directory used to start R-CLI.
Start from the same directory, or consistently use `--cwd`, if you want prior
sessions to appear in `/sessions`.

For exact formats and precedence, see:

- [Command and configuration reference](https://docs.backboard.io/cli/reference)
- [MCP servers and hooks](https://docs.backboard.io/cli/mcp)
- [Skills and discovery](https://docs.backboard.io/cli/skills)

## Custom sub-agents

The agent delegates scoped work to sub-agents through the `Agent` tool. Each
sub-agent runs with its own context and returns only a final report, so its
intermediate tool calls never enter the main session.

Define your own by adding a Markdown file to `.backboard/agents/`. The YAML
frontmatter configures the agent; the body becomes its system prompt.

```markdown
---
description: Deep-dives one question, read-only.
tools: [read, grep, glob, execute]
model: anthropic/claude-opus-5
maxRounds: 30
---

You are a research sub-agent. Never modify files.
Report findings as file paths with a one-line summary each.
```

Save that as `.backboard/agents/researcher.md` and the agent can call it with
`subagent_type: "researcher"`.

| Field             | Default          | Purpose                                                       |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `description`     | required         | Shown to the model when it picks an agent                     |
| `name`            | filename         | Lowercase letters, digits, and hyphens                        |
| `mode`            | `worker`         | `worker` uses tools; `rlm` analyzes input in a JavaScript REPL |
| `tools`           | all delegatable  | Allowlist of tool names                                       |
| `disallowedTools` | none             | Tool names to remove                                          |
| `model`           | inherits session | `provider/model`, or `inherit`                                |
| `maxRounds`       | `20`             | Tool rounds before the sub-agent is stopped                   |
| `timeoutMs`       | none             | Wall-clock budget — see "Time budgets" below                  |
| `background`      | `false`          | Run past the current turn — worker agents only, see below      |

Project files take precedence over personal ones, and both override the
built-in `worker` and `rlm` agents if they reuse those names. Files that fail
validation are skipped with a startup warning rather than blocking the session.

Sub-agents cannot prompt you, so they never receive the `ask_user`, `browser`,
or `computer` tools. Nesting is opt-in: an agent that sets `tools` must include
`agent` to spawn sub-agents of its own, and nesting stops at two levels deep.

An `rlm` agent has no tools to allow or deny, so `tools` and `disallowedTools`
do not apply to it. The rest do: its body prefixes the prompts driving the REPL
loop (but not the `llm_query` calls the loop's own code makes), `model` picks
the model for those turns, and `maxRounds` caps REPL iterations.

### Time budgets

`timeoutMs` bounds a single run. Exceeding it never throws the work away.

For a top-level sub-agent, the budget expiring means the run **moves to the
background and keeps going**. The tool returns immediately with a run id and the
path to that agent's transcript, and the report arrives as its own turn once it
finishes. This matters because a budget usually expires on a task that is merely
slow — stopping it there would discard real progress and invite the agent to
start the same work over.

```text
The sub-agent exceeded its time budget but is STILL RUNNING in the background
(id: bg_7d8405b0). It has not failed and its work is not lost.
Its transcript so far is at .backboard/sessions/<id>/agents/<call>/client.jsonl
— read that to see where it is.
```

Where a handoff is impossible — a nested sub-agent, a headless run, or an agent
that was already launched with `background: true` — expiry instead stops the run
and spends one short tool-less turn asking what it established, returning
`status: timed_out` with a partial answer. For a background agent the budget is
the only wall-clock bound it has, since nothing else is waiting on it, so it is
enforced rather than waived.

Below a run that moved to the background, budgets stop applying entirely:
nothing is waiting on those nested runs, so each finishes and reports to its
parent normally. `maxRounds` still bounds them.

A budget is separate from `maxRounds`: rounds bound how many times the agent may
call tools, the budget bounds wall-clock time. Rounds always end a run; the
budget ends the *waiting*, not necessarily the work.

### Background agents

An agent with `background: true` does not block the turn that spawned it. The
spawn returns immediately, the agent keeps working, and when it finishes its
report is delivered into the session as a new turn.

```markdown
---
description: Watches a long build and reports the outcome.
tools: [read, grep, execute]
background: true
timeoutMs: 900000
---

Run the build, wait for it, and report pass/fail with the failing output.
```

While background agents run, the status bar lists them:

```
✦ Auto mode · (shift+tab to cycle) · anthropic/claude-opus-5 · 2 agents running
  ↳ watcher   1m20s  run the build and report the outcome
  ↳ reviewer  0m14s  review the diff on this branch
```

Details worth knowing:

- **Your input always wins.** Reports are queued at a lower priority than
  anything you type, so a finished agent can never talk over you. If the session
  is idle when one finishes, it starts a turn on its own.
- **Cancelling the foreground does not kill them.** Background agents run on
  their own cancellation signal. They are stopped when you start a new thread,
  resume another session, or exit.
- **`timeoutMs` still applies to them.** Nothing is waiting on a background
  agent, so its budget is what stops it running forever; on expiry it reports
  the partial progress it has.
- **Only top-level spawns go to the background.** A sub-agent that spawns
  another one runs it inline regardless of the flag, so no agent is left without
  someone to report to.
- **`/undo` does not cover them.** A background agent outlives the checkpoint of
  the turn that spawned it, so its file edits are deliberately not journaled
  there rather than being written into an already-finalized checkpoint. Prefer
  read-only tools for background agents that you do not want to review by hand.
- **At most four *launched* background agents run at once**; further ones queue.
  A run that reaches the background by exceeding its budget was already going, so
  it is not throttled — the cap bounds what is started, not what is adopted.
- **`--print` and `--format json` ignore the flag.** A headless run exits after
  one prompt, so background agents there would be cancelled before reporting;
  they run inline instead and the answer includes their work.

## Environment variables

Most users do not need environment variables.

| Variable                             | Purpose                                                               |
| ------------------------------------ | --------------------------------------------------------------------- |
| `BACKBOARD_API_KEY`                  | Use a Backboard API key instead of the saved SSO login                |
| `BACKBOARD_API_URL`                  | Override the API base URL; defaults to `https://app.backboard.io/api` |
| `BACKBOARD_OAUTH_CLIENT_ID`          | Override the first-party public OAuth client ID                       |
| `BACKBOARD_ALLOW_INSECURE_API_URL=1` | Permit a non-HTTPS API URL for internal development                   |
| `BACKBOARD_MAX_FPS`                  | Set interactive rendering to 1-120 FPS; defaults to 30                |
| `BROWSER_PATH`                     | Use a specific Chrome or Chromium executable                          |
| `BROWSER_CDP_URL`                  | Connect the Browser tool to an existing CDP HTTP endpoint             |
| `BROWSER_WS_URL`                   | Connect the Browser tool to an existing CDP WebSocket endpoint        |

Environment variables override saved Backboard credentials where applicable.
Never commit real credentials to `.env`.

Lower `BACKBOARD_MAX_FPS` for slow SSH or tmux connections, or raise it to 60
or 120 on faster local terminals.

## Run from source

### Prerequisites

- [Bun](https://bun.sh/) installed and available on `PATH`
- Git
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for repository search

Clone the repository and enter this package:

```sh
git clone https://github.com/Backboard-io/Backboard-R-CLI.git
cd Backboard-R-CLI
```

Install exact dependencies from `bun.lock`:

```sh
bun install --frozen-lockfile
```

Sign in once:

```sh
bun run dev --login
```

Then launch the interactive application:

```sh
bun run dev
```

You can pass normal CLI flags through the development script:

```sh
bun run dev --cwd /path/to/project
bun run dev --print "summarize this package"
```

Bun automatically reads a local `.env` file. For backend development you may
copy `.env.example` to `.env` and set `BACKBOARD_API_URL` or an explicit
`BACKBOARD_API_KEY`, but a normal contributor login does not require this.

## Compile a local binary

Build a native binary for the current operating system and architecture:

```sh
bun run build
```

The output is:

```text
backboard
```

On Windows it is `backboard.exe`.

Run it in place:

```sh
./backboard --version
./backboard
```

### Put a source build on `PATH`

On macOS or Linux, link the compiled binary into a user-owned bin directory:

```sh
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/backboard" "$HOME/.local/bin/backboard"
```

If `~/.local/bin` is not already on `PATH`, add this line to your shell startup
file (`~/.zshrc`, `~/.bashrc`, or `~/.profile`):

```sh
export PATH="$HOME/.local/bin:$PATH"
```

Reload the shell and verify:

```sh
source ~/.zshrc  # use the startup file for your shell
backboard --version
```

On Windows PowerShell, after building:

```powershell
$bin = (Resolve-Path .).Path
[Environment]::SetEnvironmentVariable(
  'Path',
  [Environment]::GetEnvironmentVariable('Path', 'User') + ";$bin",
  'User'
)
```

Open a new PowerShell window, then run:

```powershell
backboard --version
```

The build embeds a custom `BACKBOARD_OAUTH_CLIENT_ID` only when that variable is
set at build time. Otherwise it uses the built-in first-party public client ID.
Never embed an OAuth client secret or API key.

## Development workflow

Run the complete validation suite before submitting a change:

```sh
bun run validate
bun run build
```

`bun run validate` runs:

```sh
bun run lint
bun run typecheck
bun test
```

Useful focused commands:

```sh
bun test tests/Config.test.ts
bun run lint
bun run lint:fix
bun run format
bun run format:check
bun run typecheck
```

Install the repository's pre-commit hook:

```sh
bun run prepare
```

The hook runs `bun run precommit`, which runs the full validation suite.

### Release builds

Maintainers can cross-compile all production targets:

```sh
bun run build:release
```

The release script:

- builds macOS, Linux glibc, Linux musl, and Windows binaries;
- emits standard and baseline x64 variants where supported;
- writes SHA-256 sidecars;
- removes generated source maps; and
- scans binaries for common secret shapes before staging them.

Artifacts are staged under the monorepo's `cli/dist-native/` directory. This is
a release-maintainer workflow, not required for normal development.

## Troubleshooting

### `backboard: command not found`

Open a new terminal after installation. If it still fails, check:

```sh
ls -l "$HOME/.backboard/bin/backboard"
printf '%s\n' "$PATH"
```

Run the binary directly to distinguish an installation problem from a `PATH`
problem:

```sh
"$HOME/.backboard/bin/backboard" --version
```

Then add the install directory to your shell startup file:

```sh
export PATH="$HOME/.backboard/bin:$PATH"
```

### Login does not complete

Run `backboard login` again, open the printed URL, and enter the displayed code.
The browser does not need to be on the same machine as the CLI. If a shell-level
`BACKBOARD_API_URL` points at another environment, unset it before retrying.

### Logout appears ineffective

Check whether the shell still exports a credential:

```sh
printenv BACKBOARD_API_KEY
```

If it does:

```sh
unset BACKBOARD_API_KEY
```

### File search fails

Install ripgrep:

```sh
# macOS
brew install ripgrep

# Ubuntu or Debian
sudo apt-get install ripgrep
```

### A tool is denied in `--print` mode

Headless runs cannot answer permission prompts. Add a narrowly scoped allow
rule to `.backboard/settings.json`, or use `--permission-mode bypass` only in a
disposable environment. See the
[automation permissions guide](https://docs.backboard.io/cli/permissions#headless-and-automation).

### The agent changed something unexpectedly

Inside R-CLI:

```text
/undo
```

With git:

```sh
git status
git diff
```

Avoid broad restore or cleanup commands until you have checked for uncommitted
and untracked work.

## Security

- Do not commit `.env`, API keys, MCP authorization headers, or hook secrets.
- Review project `.backboard/mcp.json` and `.backboard/hooks.json` files before
  using an unfamiliar repository.
- Keep the default permission mode until you understand a project's scripts.
- Use `bypass` only in isolated, disposable environments.
- Report suspected vulnerabilities privately to the Backboard maintainers
  rather than opening a public exploit report.

## License

Backboard R-CLI is released under the [MIT License](./LICENSE).

Before accepting public contributions, add a `CONTRIBUTING.md`, code of
conduct, and security-reporting policy and link them from this README.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Backboard-io/Backboard-R-CLI&type=Date)](https://star-history.com/#Backboard-io/Backboard-R-CLI&Date)
