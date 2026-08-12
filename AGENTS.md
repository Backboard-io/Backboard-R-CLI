# Backboard R-CLI Engineering Guide

## Project Goal

Backboard R-CLI is a Bun-compiled Backboard coding-agent shell. It should stay modular, typed, testable, and easy to extend over years without turning into a monolith.

## Architecture

- `src/entrypoints/cli.tsx`: process entrypoint only. Parse config, create infrastructure, render the app, flush logs.
- `src/config/`: environment, flags, defaults, profiles, and runtime path layout. Keep model/profile/memory decisions here.
- `src/core/bus/`: typed event system. All agent/UI/log state transitions should flow through `AgentEvent`.
- `src/core/agent/`: turn orchestration only. Backboard assistant/session binding, request loop, cancellation, and tool-output submission.
- `src/core/session/`: in-memory session projection plus durable JSONL logs. Never log secrets.
- `src/core/skills/`: skill discovery, validation, catalog budgeting, activation, and `SkillController` picker/selection state. Discovery is user-triggered through `/skills`.
- `src/core/mcp/`: MCP config loading, `/mcp` manager orchestration, curated catalog entries, manual config writing, env expansion, client management, and generated tool-name mapping. Transport details stay here.
- `src/core/hooks/`: command hook config loading, project-hook trust checks, hook hashing, command execution, `/hooks` manager summaries, and runtime hook orchestration.
- `src/core/tools/`: abstract tool infrastructure: base class, registry, scheduler, schema conversion, context.
- `src/core/permissions/`: the gate between a scheduled tool call and execution: modes, rule matching, command classification, and the interactive prompt.
- `src/core/checkpoints/`: per-session pre-image journals backing `/undo`, `/redo`, and `/rewind`.
- `src/core/context/`: context accounting and `Compactor`, shared by both backends.
- `src/core/keys/`: provider key storage, validation, and the `/keys` surface. Encrypted at rest, never read from environment variables.
- `src/core/auth/`, `src/core/oauth/`: Backboard OAuth device-authorization login and the shared localhost-redirect helper.
- `src/core/lsp/`: optional language-server diagnostics behind `--lsp` and `/lsp`.
- `src/core/browser/`, `src/core/computer/`: runtimes behind the `Browser` and `Computer` tools, gated by `/browser` and `/cua`.
- `src/core/attachments/`, `src/core/todos/`, `src/core/update/`, `src/core/platform/`, `src/core/image/`: supporting services.
- `src/providers/`: `AgentClient` is the model-backend contract; `ClientRouter` picks a backend and `createAgentClient` builds it from live credentials.
- `src/providers/backboard/`: REST-only Backboard transport and provider mappers. No SDK dependency.
- `src/providers/byok/`: direct vendor APIs for bring-your-own-key runs, one adapter per vendor plus a `registry.ts` entry.
- `src/tools/`: one concrete tool class per file. Keep tool logic self-contained.
- `src/prompts/`: prompt modules only. Tool/system wording lives here, not in tool implementations.
- `src/ui/`: Ink/React UI. It subscribes to events and renders state; avoid business logic here.
- `src/state/`: pure UI projection/reducer logic.
- `src/utils/`: small generic helpers only.
- `tests/`: Bun tests for every core behavior added or changed.

## Coding Principles

- Prefer small classes/files with one responsibility.
- Keep boundaries strict: UI does not execute tools, tools do not call Backboard, providers do not render UI.
- Use TypeScript strictness as design feedback, do not silence it with `any`.
- Keep TypeScript interfaces and type aliases in dedicated typing files such as `types.ts`, not inline in implementation files.
- Keep shared/static constants in dedicated constants files such as `constants.ts`, not inline in implementation files.
- Do not add speculative fallback code for unknown shapes, such as checking many possible field names when the real contract can be known. Use TypeScript types, local source/schema inspection, or focused tests to confirm the correct field or behavior before implementing.
- Follow Biome lint and format rules. Do not use non-null assertions (`value!`); add explicit guards instead.
- Use Zod schemas for every tool input, then convert to Backboard/OpenAI tool schema.
- Preserve exact, case-sensitive tool names. Do not add aliases or hidden compatibility names.
- Prompt wording belongs in `src/prompts/**`, not embedded in core logic.
- Keep prompts concise and specific. More prompt is not automatically better.
- Treat Backboard as the source of model/thread truth, but keep local logs sufficient to reconstruct a run.
- Keep the Backboard assistant/thread stable. Dynamic skills, MCP tools, and lazy tools are local per-turn `system_prompt`/`tools` overrides; do not create a new assistant or reset the thread for them.
- Never log API keys, auth headers, session tokens, or secrets.
- Read-only tools may run in parallel; write/destructive/user-interactive tools must run serially.
- Tool calls with matching command hooks must run serially unless hook concurrency metadata is explicitly added later.
- Cancellation must propagate through `AbortSignal` to Backboard requests and tools.
- Do not submit partial or stale tool outputs. Submit only currently pending tool call ids.
- Memory mode is a profile decision (`coding` uses `auto`); do not hardcode a mode outside `src/config/`.
- Keep skills opt-in and progressive-disclosure: no startup discovery, `/skills` opens a picker, catalog only includes selected skills, full `SKILL.md` only for explicit `$skill-name` activation, bundled resources read only when needed.
- Cache only remote directory listings in-process; local skill discovery must keep reading the filesystem so repo and personal changes show up.
- Keep MCP explicit and user-triggered in v1: config files and `/mcp` manager only, hot-load newly added servers into the current process, disable/remove servers from the current process when requested, support browser OAuth for HTTP MCP servers, no MCP resources, no SSE transport, and no auto-install from skills.

## Documentation Rules

- Keep `README.md` and `ARCHITECTURE.md` aligned with user-facing setup, validation, and architecture changes.
- Keep this `AGENTS.md` current. When a change updates project rules, validation commands, architecture boundaries, or agent workflow, update `AGENTS.md` in the same change.
- Do not document commands that do not exist in `package.json` unless they are direct tool commands, such as `bunx biome check --write .`.

## Tool Rules

- New tools extend `Tool<I, O>` and live in `src/tools/<Name>Tool.tsx`.
- Register new tools in `src/tools/index.ts`.
- Add a prompt module in `src/prompts/tools/` and export it from `src/prompts/tools/index.tsx`.
- Add tests for schema validation, execution, and scheduler behavior when relevant.
- Mark `isReadOnly`, `isConcurrencySafe`, and `isDestructive` truthfully.

## Skill Rules

- Discover local skills only when the user runs `/skills`: repo skills from `cwd` up to repo root, personal skills from `~/.agents/skills`, and remote listings from public skills.sh leaderboard pages. The picker supports current-tab search; Personal also shows repo skills marked `active`. Import remote skills with the official `npx skills add ...` flow, normalize them into `.agents/skills`, then load them. Do not auto-load all skills.
- Skill folder name and frontmatter `name` must match exactly. Use lowercase letters, digits, and hyphens.
- Skip malformed skills with `system:warning`; do not fail startup.
- Do not add Backboard R-CLI-specific skill locations or new MCP/plugin behavior unless explicitly requested.

## MCP Rules

- Load MCP config from `<repo-root>/.backboard/mcp.json`, then `~/.backboard/mcp.json`; user fields win.
- `/mcp` may add curated catalog or manual entries to project `.backboard/mcp.json`; newly added servers should connect immediately and register their tools for the current session. Disabling or removing a server must update the config source(s) it was loaded from, close its transport, and unregister its current-session tools. Connected servers that advertise `tools.listChanged` must sync `notifications/tools/list_changed` updates into local per-turn tool overrides.
- The MCP catalog is a manually curated in-repo list. Do not fetch the official MCP registry or Glama at runtime.
- Support stdio and Streamable HTTP only. Unsupported transports produce `system:warning`, not startup failure.
- Expand `${VAR}` and `${VAR:-fallback}` in memory only for command, args, env, url, and headers. Never rewrite config with expanded values.
- `enabledTools` is an allowlist and takes precedence over `disabledTools`. Filtered tools must not be registered with Backboard.
- Register MCP tools as `mcp__<server>__<tool>` after sanitizing/capping the generated function name. Preserve original server/tool names for wire calls.
- Treat missing MCP annotations conservatively: only `readOnlyHint: true` tools may run concurrently, and `destructiveHint: true` tools are destructive.
- Close MCP transports before exit and never log auth headers or expanded secrets.

## Hook Rules

- Hooks are command hooks only. Do not add an in-process plugin runtime unless explicitly requested.
- Load hook config from `<repo-root>/.backboard/hooks.json` and `~/.backboard/hooks.json`.
- User hooks are trusted by default. Project hooks loaded from disk must be skipped unless their computed `sha256:` hash is listed in user config `trustedProjectHookHashes`; never auto-persist trust for hooks discovered on disk. A project hook the user adds interactively through `/hooks` may be trusted as part of that explicit add.
- Supported hook events are `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`.
- Hook commands receive JSON on stdin and may return JSON on stdout. Keep hook input/output contracts typed in `src/core/hooks/types.ts`.
- Run `SessionStart` and `UserPromptSubmit` hooks from `AgentController`. Run `PreToolUse` and `PostToolUse` hooks from `ToolScheduler`, including tools used by sub-agents.
- `/hooks` UI data goes through `HookManagerController`; UI components must not write hook config directly.
- Sanitize hook environments. Do not pass Backboard API keys, auth headers, OAuth tokens, session tokens, or expanded secrets to hook processes.
- Prompt hooks must run before a blocked prompt is added to session state or logs.
- Tool hooks must not cause partial/stale tool outputs to be submitted. Invalid hook rewrites should return an error output for that tool call.

## Permission Rules

- Every tool call reaches execution through `resolveToolPermission`. Do not add a path that runs a tool around the gate, including for sub-agents.
- `decidePermission` is a first-match pipeline: deny rule → ask rule → tool verdict → read-only → bypass → allow rule → ask. Deny and ask rules sit above the bypass gate on purpose; no mode may skip them.
- Non-interactive runs (sub-agents, `--print`, `--format json`) have nobody to prompt, so an "ask" there is a hard denial. Keep the read-only shortcut for them rather than failing every `Read` and `Grep`.
- Persisted grants must not widen what the user approved. Path content is written as an `=literal` rule, destructive commands persist their exact invocation, and only ordinary commands generalize to a two-token `prefix:*`.
- Show the rule a prompt would write before the user accepts it.
- `bypass` stays flag-only and out of the Shift+Tab cycle.
- Missing or corrupt `settings.json` must resolve to empty settings, never a startup failure.

## Backboard Rules

- Use REST API only via `BackboardClient`.
- All Backboard requests/responses must go through `ServerEventLog`.
- Redact sensitive headers before persistence.
- Keep provider-specific response shapes inside `providers/backboard/mappers.ts`.
- If a backend/default assistant leaks stale tools, fix assistant isolation/config, not local aliases.

## UI Rules

- UI is event-driven. Components should render `AppState`, not mutate agent internals.
- UI calls core controllers for business workflows such as `/skills` and `/mcp`; it should not parse MCP catalog data or write config files directly.
- Slash commands live in `src/ui/commands`.
- Backboard theme colors live in `src/ui/theme`.
- Keep terminal output clean; stdout belongs to Ink in interactive mode.

## Validation

Before handing off changes:

1. `bun run validate`
2. `bun run build`

`bun run validate` runs lint, typecheck, and tests.

Pre-commit hooks:

- `.githooks/pre-commit` runs `bun run precommit`.
- `bun run precommit` runs `bun run validate`.
- `bun run prepare` installs the repo hook path with `git config core.hooksPath .githooks`.

Useful fix commands:

- `bunx biome check --write .` applies safe Biome lint fixes and formatting.
- `bun run format` formats files.

For Backboard/tool-loop changes, also run a live `./backboard --print ...` smoke test when appropriate.
