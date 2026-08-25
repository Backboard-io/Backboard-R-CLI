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

Resume a saved Backboard or local BYOK session by the ID shown when the CLI
exits or in `/sessions`:

```sh
backboard --resume SESSION_ID
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

## Computer use

`/cua` lets the agent see and control the local desktop through the `Computer`
tool. Each call runs a batch of actions (click, type, key, scroll, drag, zoom,
openApp, …) and returns the screen once afterwards: a downscaled screenshot plus
the frontmost window's interactive elements, so the model can click by element
id instead of guessing coordinates.

Requirements:

- **macOS 14+**: grant your terminal *Screen Recording* and *Accessibility*
  permission (System Settings → Privacy & Security). The first action compiles
  a small native helper with the Xcode Command Line Tools (`xcode-select
  --install`); it is cached under `~/.backboard/bin` and reused.
- **Windows**: actions run through a persistent PowerShell helper; nothing to
  install.
- Linux desktops are supported through the eval harness only (Daytona).

Screenshot-only batches are treated as read-only; anything that clicks or types
asks for permission like any other mutating tool, and the prompt lists the
batch. Screenshots are kept under `~/.backboard/screenshots/<session>` and
pruned automatically.

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
| `/sessions`, `/session`     | Browse Backboard and local BYOK sessions   |
| `/resume SESSION_ID`        | Resume a session directly by ID            |
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
bun run typecheck:scripts
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

### Computer-use checks and evals

Unit tests cover the tool contract with a fake platform. The real machine and
the model are exercised by opt-in scripts:

```sh
bun run cua:e2e        # macOS: compiled helper, capture, accessibility, settle (read-only)
bun run cua:smoke      # macOS/Windows: opens the text editor, types, verifies, closes
bun run cua:grounding  # Tier 0: replays saved screenshots through the model; click-in-bounds
bun run cua:eval       # Tier 1: real agent loop on programmatic tasks in Daytona XFCE sandboxes
```

`cua:grounding` needs `BACKBOARD_API_KEY`; `cua:eval` also needs
`DAYTONA_API_KEY` (both are read from `.env` or `../cli-eval/.env`). Record new
grounding fixtures from an app on your screen with
`bun run scripts/cua-eval/capture-fixture.ts --open <App> --window --target <name>`.
See `docs/cua-research.md` for the design, measurements, and the eval plan.

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

### Computer use cannot see or control the screen

On macOS the tool reports `accessibilityTrusted: false` or a capture error when
the terminal lacks *Accessibility* or *Screen Recording* permission; grant both
and retry the action. A compile error mentions `swiftc`: install the Xcode
Command Line Tools with `xcode-select --install`. Non-QWERTY layouts (Colemak,
Dvorak, …) are handled — keys are resolved through the active layout.

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
