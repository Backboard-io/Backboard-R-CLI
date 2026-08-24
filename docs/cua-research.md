# CUA (Computer Use) — review, research, implementation, and evals

Branch `qli/main/cua`. Written 2026-08-24 from a code review of the previous `Computer` tool plus web research on provider tool designs, speed techniques, and eval infrastructure; Part 6 documents what was then built on this branch and the measured results. Every external claim carries a source link. Local latency numbers were measured on a 2× Retina MacBook with a second display attached.

**TL;DR**

1. Two bugs make the current tool wrong, not just slow: coordinates are in the wrong space on every Retina Mac (C1), and a multi-action queue ships up to 21 full screenshots in one tool result (C2).
2. Every provider (Anthropic, OpenAI, Gemini, Qwen) converged on the same design: screenshot-only observation at ~1280×800 in the screenshot's own pixel space, a fixed action vocabulary incl. scroll/drag/double-click/zoom, **multi-action batches per model call ending with one observation**, and safety pushed to the harness. Our `actions[]` queue is already the right shape; the prompt tells the model to use it one step at a time, which throws the advantage away.
3. Speed comes from removing model calls (75–94% of latency), then from a persistent native helper instead of `swift -e`/`osascript`/`powershell.exe` per action (0.3–1.4 s each, measured), then from settle-detection instead of fixed sleeps.
4. Evals: Daytona has a native `computerUse` API (XFCE + AT-SPI + screenshots + recordings) at ~$0.17/h per desktop; we already run Harbor jobs there. A three-tier suite (grounding fixtures → trajectory replay → 20 programmatic XFCE tasks) costs ~$3–8 per full run.

## Part 1 — Bugs and gaps in the current implementation

Found by code review of `src/core/computer/*`, `src/core/platform/*`, `src/tools/ComputerTool.tsx`, the two prompt copies, and `tests/ComputerTool.test.ts`. Numbers measured on a 2× Retina MacBook with a second display attached.

### Critical

| # | Bug | Where | Detail / fix |
|---|-----|-------|--------------|
| C1 | **Retina / HiDPI coordinate mismatch.** Screenshot is in physical pixels (2940×1912 here) but AX bounds and `System Events click at` are in points (1470×956). `screenSize` and `screenshotScale` are pixel-based, so any model-derived `{x,y}` lands 2× off. `elementId` clicks only work because AX bounds are already points, which hides the bug. | `MacPlatform.ts:19`, `ScreenCapture.ts:27` | Report point-space `screenSize` (`NSScreen.main.frame` or `pngSize / backingScaleFactor`), define `screenshotScale = imagePx / points`, state the contract in the prompt. Windows has the same class of bug: PowerShell isn't DPI-aware, so `CopyFromScreen`/`Cursor.Position` are scaled while UIA `BoundingRectangle` is physical. |
| C2 | **Up to 21 full screenshots in one tool result.** Every `click`/`openApp` captures a post-action observation *and* the queue appends a final one; each ≤1.5 MB raw → ~2 MB base64. A 20-action queue can emit ~40 MB of JSON as `forLLM`, which is also piped to post-tool hooks and written to the session log. Unverified whether the server extracts `__image_base64` from *nested* `results[i].observation`. | `ComputerRuntime.ts:41-53, 95-103` | Keep only the last observation's image in the payload; earlier ones keep `screenshotPath` only. Skip the trailing capture when the last action already produced one. |
| C3 | **Windows advertises `type`/`key` but throws "not implemented".** Schema and prompts list all six actions on every platform. | `WindowsPlatform.ts:90-93` | Implement via `SendInput`/`SendKeys` or filter schema+prompt by platform. |

### High

| # | Bug | Where | Detail / fix |
|---|-----|-------|--------------|
| H1 | **"Fresh screenshot" is not enforced.** `lastObservation` is any observation ever taken; one `ComputerRuntime` lives for the process (survives turns and `/new`). `observationId` is emitted but never checked. `type`/`key` don't recapture, so `click {elementId}` after typing resolves against stale bounds. | `ComputerRuntime.ts:117-131`, `ComputerPlatformAction.ts:47` | Accept `observationId` on click and reject if stale; or invalidate after `type`/`key`/`wait`. |
| H2 | **No scroll, drag, double-click, hover, mouse-move, key hold.** Only `PAGEDOWN` works around scrolling. | `ComputerTypes.ts:36-42` | See Part 2 action set. |
| H3 | **Accessibility snapshot quality.** `maxElements=120, maxDepth=6` from the *app* root — browsers/Electron exhaust the budget on chrome. No filtering of non-interactive roles (`AXGroup`, `AXSplitGroup`) or off-screen elements. Each element repeats `appName/processId/windowTitle` (~120× redundant). `windowTitle` reads `kAXTitle` on the *application* element → returns the app name ("Ghostty") not the window title (measured). Errors swallowed to `elements: []` so a missing Accessibility permission is silent. | `MacPlatform.ts:98-200` | Start from the focused window, walk `AXVisibleChildren`, whitelist interactive roles, dedupe per-element metadata, surface the AX error. |
| H4 | **`swift -e` JIT-compiles per screenshot: 1363 ms cold / 332 ms warm** (measured) and requires Xcode CLT. | `MacPlatform.ts:29` | Compile once to a helper binary at install/first-run, or a persistent Swift daemon over stdio. |
| H5 | **AppleScript string escaping.** `JSON.stringify` as an AppleScript literal: `\uXXXX` isn't an AppleScript escape → typed literally. `keystroke` is slow and drops chars on long text. | `MacPlatform.ts:56, 260` | Clipboard + ⌘V for text > ~200 chars; CGEvent unicode typing otherwise. |
| H6 | **Key coverage.** `F1–F12`, `CAPSLOCK`, `INSERT`, `FORWARDDELETE` throw; `DELETE→117` is forward-delete; supported names are undocumented; `KeyName` is `string & {}` so nothing is type-checked. | `MacPlatform.ts:223-244`, `ComputerKeys.ts` | Full key-code table (xdotool-style names, which every provider now uses). |

### Medium

| # | Bug | Where |
|---|-----|-------|
| M1 | Multi-monitor: `screencapture <path>` = main display only; AX elements on other displays carry coordinates outside the image (this machine's desktop union is `0,-577 → 3390,956`). Windows: `PrimaryScreen` only. | `MacPlatform.ts:19`, `WindowsPlatform.ts:19` |
| M2 | Permissions: `isDestructive()` is true but no `checkPermissions`/`summarizeInput`, so every call (even a bare `screenshot`) asks "Allow Computer?" with no detail, and one persisted allow covers everything. | `ComputerTool.tsx:150-160` |
| M3 | `~/.backboard/screenshots` has no retention — 187 MB / 24 sessions on this machine. | `ComputerPaths.ts` |
| M4 | `delay()` leaks abort listeners; `capturePostActionObservation` calls it with no aborted check, so an already-aborted signal never rejects. | `ComputerRuntime.ts:157` |
| M5 | Two divergent prompt copies (`prompts/tools/computer.tsx` vs `profiles/openai/tools/index.tsx:311`); neither documents action shapes, key format, coordinate space, or which actions auto-screenshot. | |
| M6 | `publicTargetSchema` makes `elementId`/`x`/`y` all optional, so `target: {}` passes the advertised schema and fails the runtime union with an opaque Zod error. | `ComputerTool.tsx:88-100` |
| M7 | Fixed sleeps: 300 ms after click, 1200 ms after `openApp`, with no UI-settle detection. | `ComputerRuntime.ts:138` |
| M8 | Tests lack: `macKeyScript`/`appleScriptString` output, multi-action final-screenshot + payload size, `stopOnError:false`, unknown/boundless `elementId`, abort mid-queue, all of `WindowsPlatform`. | `tests/ComputerTool.test.ts` |
## Part 2 — How the major providers design CUA tools and prompts (2025 → Aug 2026)

### Anthropic

Tool versions ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [quickstart computer.py](https://raw.githubusercontent.com/anthropics/anthropic-quickstarts/main/computer-use-demo/computer_use_demo/tools/computer.py)):

| Version | Notes |
|---|---|
| `computer_20241022` | 10 actions: `key, type, mouse_move, left_click, left_click_drag, right_click, middle_click, double_click, screenshot, cursor_position` |
| `computer_20250124` | adds `left_mouse_down, left_mouse_up, scroll, hold_key, wait, triple_click` |
| `computer_20251124` | adds `zoom` (gated by `enable_zoom`) |
| `computer_toolset_20260801` (GA Aug 2026) | **17 member tools** instead of one `action` enum; `display_width_px/height/number` are *rejected* — model infers from the image |

Action shapes: `screenshot {}`; `zoom {region:[x0,y0,x1,y1]}` (crop at full physical res); `left|right|middle|double|triple_click {coordinate?:[x,y], text?:"ctrl+shift"}`; `left_click_drag {start_coordinate, coordinate}`; `mouse_move`; `left_mouse_down/up`; `scroll {scroll_direction, scroll_amount(clicks), coordinate?}`; `type {text}`; `key {text:"Return"|"ctrl+s", repeat?}`; `hold_key {text, duration}`; `wait {duration}`.

- **Coordinates are in screenshot pixels**, origin top-left. macOS Retina: downscale screenshot 2× or halve returned coords.
- **Resolution**: recommend 1024×768 / 1280×800 / 1366×768; max 1920×1080. Quickstart scales to the nearest of XGA/WXGA/FWXGA by aspect ratio and maps coordinates back. ~1,000–1,800 tokens per screenshot; >20 images per request hits a stricter per-image limit.
- **Batching**: model may emit several `tool_use` blocks per turn; run sequentially; on first failure later blocks get `is_error:true, "Not executed: an earlier computer action in this turn failed."`; if the batch doesn't end in `screenshot`, the harness attaches an image to the last result.
- **Prompting** (official): "After each step, take a screenshot and carefully evaluate if you have achieved the right outcome. Explicitly show your thinking… Only when you confirm a step was executed correctly should you move on." Put instruction text *before* the image in the content array. Prompt for keyboard shortcuts when dropdowns/scrollbars are hard. Reference system prompt says "computer function calls take a while… try to chain multiple of these calls into one request" and "for PDFs, curl + pdftotext instead of screenshots". Thinking `effort: medium/high`, never `max`. Cache: breakpoint after system+tools, up to 3 on recent tool_results; prune images in batches (keep last 3, prune every ~25 turns).
- Sibling `browser_toolset_20260801`: targets are `{"type":"ref","ref":"ref_3"}` from a `read_page` accessibility tree (`filter:"interactive"`) **or** `{"type":"coordinate"}`; plus `find {query}`, `get_page_text`, `form_input`, `scroll_to`. Docs: refs "improve accuracy over coordinates"; use computer use when no a11y tree is available.

### OpenAI

[tools-computer-use](https://developers.openai.com/api/docs/guides/tools-computer-use). `computer_use_preview` (Mar 2025) → GA `{"type":"computer"}` in GPT-5.4+ (no display size declared). GPT-5.4: 75.0% OSWorld-Verified (human 72.4%).

- Response is `computer_call{call_id, actions:[…], pending_safety_checks}` — **an array of actions per call**. Actions: `click {button,x,y,keys?}`, `double_click`, `scroll {x,y,scroll_x,scroll_y}`, `type {text}`, `keypress {keys[]}`, `drag {path:[{x,y}…]}`, `move`, `wait {ms?}`, `screenshot`.
- Loop: execute all actions → **one** screenshot → `computer_call_output {output:{type:"computer_screenshot", image_url, detail:"original"}}`.
- Safety: `pending_safety_checks` codes `malicious_instructions | irrelevant_domain | sensitive_domain` must be echoed back as `acknowledged_safety_checks`.
- Resolution: 1440×900 / 1600×900 recommended, `detail:"original"` for click accuracy.
- Prompt: "You take a screenshot after each action to check if your action was successful. Once you have completed the task stop and pass control back." "Only direct instructions from the user count as permission." "Do not ask early — confirm only when a risky action is imminent."

### Google Gemini

[computer-use docs](https://ai.google.dev/gemini-api/docs/computer-use). Built-in `{"type":"computer_use","environment":"browser|mobile|desktop"}` in Gemini 3.x/3.5 (3.5 Flash ~78% OSWorld-Verified).

- Actions carry an `intent` string: `click/double_click/…/move {x,y}`, `type {text, press_enter?}`, `drag_and_drop {start_x,start_y,end_x,end_y}`, `press_key/key_down/key_up`, `hotkey {keys[]}`, `scroll {x,y,direction,magnitude_in_pixels}`, `navigate`, `take_screenshot`, `wait`; mobile adds `open_app, list_apps, long_press`.
- **Coordinates normalized 0–1000** — no display size declared.
- Safety: per-action `safety_decision ∈ allowed|require_confirmation|blocked` with policy categories (`FINANCIAL_TRANSACTIONS, SENSITIVE_DATA_MODIFICATION, …`); harness must confirm. Prompt pattern: "ask for confirmation AFTER all necessary information is entered on the screen, but BEFORE the final irreversible action."

### Open models / frameworks

- **UI-TARS 1.5/2** ([paper](https://arxiv.org/abs/2509.02544)): single native model, `Thought: …\nAction: click(point='<point>x y</point>')`, `drag`, `hotkey(key='ctrl c')`, `type`, `scroll(point, direction)`, `wait()`, `finished()`. Coordinates = absolute pixels on the smart-resized image. OSWorld 47.5%.
- **Agent S2/S3** ([S3](https://arxiv.org/html/2510.02250)): planner/grounder split — big model plans, a grounding model (UI-TARS-72B) maps "the Save button" → pixels; S2 adds OCR + structural (spreadsheet cell) experts; S3 adds a coding agent as an action and Behavior Best-of-N. 72.6% OSWorld-Verified.
- **OpenCUA**: pyautogui-style action space, absolute pixels, 3 recent screenshots in context, reflective CoT. 45%.
- **Qwen3-VL / Qwen-UI-Agent** (Jul 2026, 79.5% OSWorld-Verified): Anthropic-shaped `computer_use` schema with 0–1000 coords; adds `cli_command`, `api_call`, `ask_user`; **>40% of outputs are batched actions**; "zoom-in" grounding → 81.5% ScreenSpot-Pro.
- **Grounders**: OS-Atlas / UGround (0–1000 point), GUI-Actor (coordinate-free attention). ScreenSpot-Pro fixed mostly by iterative zoom/crop.

### Observation consensus

- All top desktop systems are **screenshot-only**; a11y trees return only as a *browser* affordance. [OSWorld-Human](https://arxiv.org/html/2506.16042v1): a11y tree generation costs 3–26 s and thousands of tokens per step, app-dependent benefit (helps GIMP, hurts Writer); LLM inference is 75–94% of task latency.
- Coordinate conventions: absolute-in-screenshot (Anthropic, OpenAI) or 0–1000 (Gemini, Qwen). Client owns the mapping to physical pixels; declared display sizes are being removed from schemas.
- Send minimal structured text with the screenshot: window/app/URL state, short recent-action history, task text.
- Prefer keyboard shortcuts and CLI/code delegation over pixel-level widget fiddling (Agent S3, UI-TARS-2, Qwen `cli_command`).
## Part 3 — Making it MUCH faster: batching, screenshots, native tools, verification

### 3.1 Batching / multi-action per model call

- **Anthropic**: model returns several `tool_use` blocks in one turn; execute sequentially, stop at first failure, answer *every* block (skipped ones get `is_error:true, "Not executed: an earlier computer action in this turn failed."`). If the batch doesn't end with `screenshot`, attach one to the last result "to save a round trip." Reference implementation adds `computer_batch` and appends a `BATCH_REMINDER` after any lone single-action call ([best-practices repo](https://github.com/anthropics/claude-quickstarts/tree/main/computer-use-best-practices)).
- **OpenAI GA**: `computer_call.actions[]` — run all, capture *one* screenshot, return it.
- **Gemini**: parallel function calls, one `function_result` per action.
- **UFO2 (Microsoft)**: *speculative multi-action execution* — one inference emits a batch; UIA validates each action's precondition (visible/enabled) at runtime; halt early on mismatch → **51.5% fewer steps** on OSWorld-W at equal success ([paper](https://arxiv.org/html/2504.14603)).
- **OSWorld-Human**: agents take 1.4–4.3× more steps than human-optimal; "action grouping" cut steps 13.6→5.9 (Calc), 9.0→6.1 (Writer) ([paper](https://arxiv.org/html/2506.16042v1)). LLM inference is **75–94%** of task latency — every eliminated model call matters more than any local optimization.

### 3.2 Screenshot cost

- Claude tokens = ⌈w/28⌉×⌈h/28⌉: 1280×800 ≈ 1,330; 1920×1080 → 1,560 (standard tier) or 2,691 (high-res tier, 4.7+). >20 images/request → stricter 2000 px limit. Oversized tool_result images are **rejected, not downscaled**.
- JPEG q≈85 cuts bytes/upload time (tokens unchanged — token count is by dimension). Quickstart exposes `CU_JPEG_QUALITY=85`. Measured here: JPEG q70 @1280 = 241 KB vs PNG 692 KB.
- `zoom {region}` (Anthropic, default-on Opus 4.6+) returns a crop at full resolution — send small frames by default, zoom on demand. Anthropic restated Opus 4.7's OSWorld score after a zoom bug fix, i.e. zoom materially affects accuracy.
- Window-only capture: Peekaboo (macOS ScreenCaptureKit daemon) ~45 ms full-screen / ~12 ms per-window; Windows-MCP 30–60 ms.
- Frame diffing / "only send if changed" isn't documented by any vendor but is used in community tooling (pixel-identical successive captures as idle signal).

### 3.3 Native primitives (the part we control)

| | Current | Fast path |
|---|---|---|
| macOS a11y | `swift -e` per call (**1.36 s cold / 0.33 s warm** measured; 3–6 s on slower machines) | `swiftc`-compiled helper daemon over stdio: "<1 s or near-instant"; batch reads via `AXUIElementCopyMultipleAttributeValues`; cache tree with ~1.5 s TTL, invalidate on focus/window change |
| macOS input | `osascript` System Events (**355 ms** round-trip measured; 40–100 ms best case; documented multi-second `keystroke` stalls on 12.6.5+) | `CGEvent.post()` ≈ **5 ms**; type via CGEvent unicode or clipboard+⌘V for long text; quickstart types in 50-char chunks with 12 ms delay |
| macOS capture | `screencapture` (159 ms measured, PNG) | `SCScreenshotManager.captureImage` (macOS 14+) in the same daemon, JPEG/downscale in-process |
| Windows a11y | fresh `powershell.exe` per call (~440–900 ms startup) | one persistent COM STA process; UIA `CacheRequest` + `FindAllBuildCache` (P95 ≈ 17 ms); `TreeScope_Children` not `Descendants` from desktop root |
| Windows input | `mouse_event` via new PowerShell each time | `SendInput` from the persistent process (50–100 ms incl. UI) |

- Hybrid targeting: UFO2 fuses UIA elements with OmniParser detections and recovers ~10% of failures vs either alone; GUI+API "Puppeteer" cut steps 58.5%. Refs survive layout shifts; 23% of OSWorld-Human failures were grounding-related.

### 3.4 Planner / grounder / speculation / memory

- **Agent S3** dropped the hierarchical planner, added a coding-agent action: **−52% LLM calls, −62% wall-clock** (2,366 s → 891 s/task) and +13.8% success. Planning+reflection was 53%+34% of Agent S2's time; grounding 4%; screenshot+action 3%.
- Grounding models for ScreenSpot-Pro: OmniParser v2 0.6 s/frame; GTA1-32B 63.6%; Claude Opus 4.8 87.9%. Frontier models no longer need a separate grounder; small models do.
- **Speculative actions**: fast model predicts next action during env latency, commit on match → up to 20% latency cut ([arXiv 2510.04371](https://arxiv.org/abs/2510.04371)). AAPT pre-compiles policy trees in idle time: p50 round trip 567 → 325 ms ([arXiv 2607.28399](https://arxiv.org/html/2607.28399)).
- **Macros / learned shortcuts**: computer-use-plus templated action chains with tiered routing UIA → CDP → OCR → vision; Accio URL-synthesis fast path with cheap verifier → 1.9× cheaper, −33% latency on web ([arXiv 2605.16565](https://arxiv.org/html/2605.16565v1)).
- Claude for Chrome "Quick Mode": compact single-letter command language with `tools: []` + stop sequences to shrink decode length.

### 3.5 Verification without fixed sleeps

Fixed sleeps are everywhere (quickstart 2.0 s after shell, 0.5 s after click; OSWorld examples 3 s). Replacements:
- **Pixel-settle**: poll cheap captures every ~100 ms until two consecutive frames match, with timeout. Typically <300 ms vs 0.5–3 s fixed.
- **Structural**: UIA/AX precondition (element visible+enabled) before each batched action (UFO2); focused-element / window-title / frontmost-app change as a "did it change" signal; browser refs going stale on DOM change.
- Attach the observation to the last tool result instead of spending a model turn on `screenshot`.

### 3.6 Context management

- Anthropic: cache breakpoint after system+tools, up to 3 on the latest tool_results; **prune images in intervals** (keep last 3, roll every 25–40 turns) — per-turn pruning breaks the cache prefix. Quickstart defaults `image_prune_min=3`, `image_prune_interval=40`, autocompaction at 150k. Context-editing `clear_tool_uses_20250919` clears old results without a summarization turn. Files API `file_id` avoids re-sending base64.
- OpenAI GA: `previous_response_id`, truncation not required. Gemini: sends only screenshot + recent action history.

### 3.7 Published numbers

- OSWorld-Verified (100 steps): Claude Fable 5 / Mythos 5 85.0%, Opus 4.8 83.4%, Sonnet 5 81.2%, GPT-5.4 75.0%, Qwen-UI-Agent 79.5%, Agent S3 72.6%, UI-TARS-2 47.5%. Human 72.4%.
- OSWorld 2.0 long-horizon: Opus 4.7 averages **318 tool calls/task**; human median 1.6 h.
- Per-step: UI-TARS-2 4.0 → 2.5 s with W4A8; Holo 567 ms p50; Windows-MCP 0.7–2.5 s incl. LLM. GTA1 ≈ $2.43/task.

### Speed playbook for R-CLI (prioritized, with expected effect)

1. **Multi-action batches + auto-attached final observation** — already have the queue; change the prompt to "queue all confidently-known steps, end with an observation", drop per-click screenshots, attach *one* observation to the last result. 2–3× fewer model calls; ~10× smaller payloads.
2. **Persistent native helper** (compiled Swift daemon on macOS; one PowerShell/C# host on Windows) for capture + AX + input. −0.3 s (osascript) to −1.4 s (swift JIT) per action; CGEvent/SendInput ≈ 5 ms.
3. **Capture in point space at ≤1280×800, JPEG q85, plus `zoom {region}`**. Fixes the Retina bug and cuts each frame to ~1,300 tokens / ~250 KB.
4. **Settle detection instead of 300/1200 ms sleeps** (pixel-diff poll or AX focus change). −0.2 to −1 s per state-changing action.
5. **Interval-based image pruning** (keep last 3, roll every 25–40 turns) with cache breakpoints — the server side owns this today; verify it doesn't re-send every screenshot.
6. **A11y refs by default, coordinates as fallback** — already the design; make the tree small (focused window, interactive roles only, no per-element app metadata) and cache it.
7. **Prefer CLI/API paths**: the agent already has Execute/Read — tell it in the prompt to use them for files, PDFs, bulk edits rather than GUI.
8. **Flat planner, moderate thinking effort** (`medium`); no separate reflection call.
9. **Per-step telemetry** (capture / a11y / model / action / settle ms, cache-read ratio, images in context) so regressions are visible; OSWorld-Human shows late steps run 3× slower than early ones.
10. Later: speculative next-action prediction with a small model during env latency; learned macros for repeated flows.
## Part 4 — Evaluating cheaply (Daytona first)

### 4.1 Daytona Computer Use — what we actually get

Daytona has a first-class `computerUse` namespace in the TS (`@daytona/sdk`, works in Bun) and Python SDKs ([docs](https://www.daytona.io/docs/en/computer-use/), [TS ref](https://www.daytona.io/docs/en/typescript-sdk/computer-use/)).

- Desktop: **XFCE4 + Xvfb + x11vnc + noVNC** on `daytonaio/sandbox:0.6.0`; resolution fixed at creation via `VNC_RESOLUTION` env (e.g. `1024x768x24`).
- OS: Linux and Windows (`windows-small|medium|large` snapshots, +$0.0858/vCPU/h); **macOS is private alpha** — assume Linux for cheap evals.
- API surface (TS):
  ```ts
  sandbox.computerUse.start() / stop()
  mouse.click(x, y, button?, double?) · mouse.drag(x1,y1,x2,y2) · mouse.move · mouse.scroll(x, y, 'up'|'down', amount)
  keyboard.type(text, delay?) · keyboard.press(key, modifiers?) · keyboard.hotkey('ctrl+shift+t')
  screenshot.takeFullScreen() · takeRegion(region) · takeCompressed({format:'jpeg', quality, scale})
  display.getInfo() · display.getWindows()
  accessibility.getTree({scope:'focused'|'pid'|'all', maxDepth}) · findNodes({role, name, nameMatch}) · invokeNode(id) · setNodeValue(id, v)
  recording.start()/stop()/download()
  sandbox.process.executeCommand(cmd) → {exitCode, result}   // checkers
  ```
- Pricing ([page](https://www.daytona.io/pricing)): $0.0504/vCPU/h + $0.0162/GiB/h, per-second billing; 2 vCPU/4 GB desktop ≈ **$0.17/h**. Tier-1 org pool 10 vCPU → ~5 concurrent desktops. Snapshots (`daytona.create({snapshot})`, `sandbox.createSnapshot()`) give the instant-reset pattern: bake apps+fixtures once, fresh ephemeral sandbox per task, delete.
- Already in use: `Espri-API/cli-eval` runs Harbor jobs in Ubuntu Daytona sandboxes with a prewarmed setup-cache volume (`BackboardDaytonaEnvironment`, `prewarm_daytona_setup_cache.py`). A CUA suite can reuse that lifecycle with a desktop snapshot.

### 4.2 Alternatives

| Option | Notes |
|---|---|
| **E2B Desktop** | Same rate card as Daytona; Ubuntu+Xfce; `leftClick/write/press/screenshot/commands.run`; no a11y tree API. Good second vendor. |
| **Anthropic computer-use-demo Docker** | Free local reference (`ubuntu:22.04` + xdotool/scrot/noVNC, 1024×768). Runs on macOS via Docker Desktop. |
| **Cua / Lume** ([github](https://github.com/trycua/cua)) | Free macOS/Linux VMs on Apple Silicon via Apple Virtualization, APFS clone reset; Cua-Bench harness covers OSWorld/ScreenSpot/WAA. **Best path to macOS-native evals** on a dev Mac. |
| macOS cloud | AWS mac2 $0.878/h with 24-h minimum (≥$21/day); Scaleway M4 €0.22/h hourly. Not for CI. |
| Scrapybara | **Sunset Oct 2025** — drop. |
| Browserbase / Steel | Browser-only. |

### 4.3 Benchmarks

| Benchmark | What | VM? | Size / SOTA | Cost |
|---|---|---|---|---|
| **OSWorld-Verified** | Ubuntu end-to-end; programmatic `evaluator{func,result,expected}` on final state | yes | 369 tasks; `test_small` = 39; Fable 5 85%, human 72% | infra ~$8 on 50× t3.large; model tokens dominate. `inspect_evals/osworld` runs 246/369 (22/39 small) in plain Docker w/o Chrome/Thunderbird |
| **ScreenSpot-v2 / -Pro** | single-step grounding, click-in-bbox | **no** | 1,272 / 1,581 images; Opus 4.8 87.9% Pro | minutes, ~$1 |
| WindowsAgentArena | 154 Win11 tasks | yes (KVM/Azure) | — | ~20 min on Azure |
| macOSWorld / MacArena | 202 / 421 macOS tasks | yes (EC2 Mac / Apple VZ) | proprietary >30% | MacArena runs on a Mac locally |
| OSWorld-Human | efficiency metrics (WES±, steps vs human) | reuses OSWorld | — | reusable metric definitions |
| Online-Mind2Web | 300 live-web tasks, LLM judge | browser | Operator 61% | **$171–$1,610/run** — avoid |

OSWorld evaluator pattern (reusable): task JSON = `config` setup steps + `evaluator{func, result{type}, expected{type:"rule", rules}}`; getters (`vm_command_line`, `vm_file`, `accessibility_tree`) and metrics (`exact_match, check_include_exclude, file_contains, check_json, check_accessibility_tree (XPath), run_sqlite3, …`) return 0/1. Example: "turn up to the max volume" → `exact_match` on `pactl list sinks | grep Volume` expecting `100`.

### 4.4 Cheap strategies

- **(a) Grounding-only, no VM.** Fixture = `{screenshot, a11y.json, instruction, bbox}`; assert the model's click ∈ bbox. Mix ScreenSpot slices with our own macOS + XFCE captures. Runs in `bun test`; 200 images ≈ 0.3M tokens ≈ ~$1.
- **(b) Recorded trajectories + deterministic checkers.** Log `{screenshot, a11y, action}` per step (Daytona `recording` + our own log); replay observations offline and score the chosen action (exact for key/type, bbox tolerance for click). $0.
- **(c) 10–30 programmatic tasks in a Daytona XFCE snapshot** — editor/file, `xfconf-query` settings, `pactl` volume, local HTML form served by `python -m http.server` with a submission log, multi-app. Checker via `process.executeCommand`; AT-SPI `findNodes` for dialog/button state.
- **(d) LLM-as-judge on final screenshot** only for visual tasks; ~85% agreement → secondary signal.
- **(e) Metrics beyond success:** steps, per-step model vs action latency, screenshots sent, tokens, $, WES+. Fail CI on cost/step regressions, not just success.

### 4.5 `DaytonaPlatform` adapter (same agent code, Linux sandbox)

The existing `Platform` interface (`screenshot`, `accessibilitySnapshot`, `fitPngForPayload`, `execute(click|type|key|openApp)`) maps 1:1:

```ts
import { Daytona, type Sandbox } from "@daytona/sdk";

export class DaytonaPlatform extends BasePlatform {
  static async create(opts: { snapshot?: string; resolution?: string } = {}) {
    const sb = await new Daytona().create({
      snapshot: opts.snapshot ?? "backboard-cua-eval",        // baked: XFCE + apps + fixtures
      envVars: { VNC_RESOLUTION: opts.resolution ?? "1280x800x24" },
      autoDeleteInterval: 0,
    });
    await sb.computerUse.start();
    return new DaytonaPlatform(sb);
  }
  async screenshot(path, signal) {
    const r = await this.sb.computerUse.screenshot.takeCompressed({ format: "png" });
    const bytes = Buffer.from(r.screenshot, "base64");
    await writeFile(path, bytes);
    return { path, bytes, screenSize: { width: r.width, height: r.height } };   // already point == pixel
  }
  async accessibilitySnapshot() {
    const t = await this.sb.computerUse.accessibility.getTree({ scope: "focused", maxDepth: 10 });
    return normalizeAtspi(t);                                   // → AccessibilityElement[]
  }
  async execute(a: PlatformAction) {
    switch (a.kind) {
      case "click":   return void this.sb.computerUse.mouse.click(a.point.x, a.point.y, a.button);
      case "type":    return void this.sb.computerUse.keyboard.type(a.text);
      case "key":     return void this.sb.computerUse.keyboard.hotkey(toLinuxChord(a.key)); // meta→ctrl
      case "openApp": return void this.sb.process.executeCommand(`nohup ${APP_MAP[a.appName] ?? a.appName} >/dev/null 2>&1 &`);
    }
  }
  exec(cmd: string) { return this.sb.process.executeCommand(cmd); }   // eval checkers
  async dispose() { await this.sb.delete(); }
}
```
Notes: add `os: "darwin"|"win32"|"linux"` to `Platform` so the prompt can say "use ctrl on Linux"; normalize AT-SPI and macOS AX into one `AccessibilityElement` shape so grounding fixtures run against both; the eval runner owns `create → task → checker → metrics → delete`, 4–5 sandboxes in parallel.

### 4.6 Recommended plan (full run ≈ $3–8)

| Tier | When | What | Cost |
|---|---|---|---|
| 0 | every commit, ~1 min | 100–200 grounding fixtures (click-in-bbox), no sandbox | ~$0.50 |
| 0.5 | every commit | replay 10 recorded trajectories, deterministic action match | $0 |
| 1 | nightly / PR label, ~10 min | 20 programmatic tasks in Daytona XFCE (5 file/editor, 5 settings, 5 local-form web, 5 multi-app), 4–5 parallel, fresh sandbox per task | ~$0.20 infra + ~$2–6 tokens |
| 2 | weekly | `inspect_evals/osworld_small` (22 Docker tasks) or OSWorld-Verified `test_small` (39) | $10–30 |
| 3 | releases | full OSWorld-Verified 369 | infra ~$8, tokens dominate |
| mac | ad hoc, free | same tier-1 suite via Cua/Lume VM on a dev Mac | $0 |

Reuse OSWorld's `evaluator` JSON schema and metric names so real OSWorld tasks drop in later. Log success, steps, per-step latency split, screenshots sent, tokens, $, WES+; fail the build on success *or* cost/step regressions.
## Part 5 — Proposed target design for R-CLI

### Action set (align with the provider consensus)

`screenshot`, `zoom {region}`, `click {target, button, count:1|2|3, modifiers?}`, `drag {from, to}`, `move`, `scroll {target?, direction, amount}`, `type {text}`, `key {key, modifiers?, repeat?}`, `hold_key {key, ms}`, `wait {ms}`, `openApp {appName}`. Keep `target = {elementId} | {x,y}`. Drop the divergent `publicSchema`/`runtimeSchema` pair; one schema with `target` as a proper union.

### Observation contract

- Capture in **point space**: macOS `NSScreen.frame` size, PNG downscaled to ≤1280×800 (or 1366×768 by aspect), JPEG q85. `screenSize` = point size, `imageSize` = sent image size, `scale = imageSize/screenSize`. Prompt states: "coordinates are in `screenSize` space."
- One image per tool result: only the final observation carries `__image_base64`; earlier ones carry `screenshotPath`.
- a11y: focused window only, interactive roles whitelist (`AXButton, AXTextField, AXCheckBox, AXPopUpButton, AXMenuItem, AXLink, AXTab, AXRow, …`), on-screen bounds only, ≤80 elements, no per-element app metadata, real window title from `kAXFocusedWindow`. Include `focusedElementId` and `frontmostApp` at top level.
- `observationId` becomes meaningful: click/drag/scroll require the latest id (or reject as stale). `type`/`key` invalidate element bounds but not the id.

### Runtime

- Batch semantics as Anthropic/OpenAI: run sequentially, stop on first failure, mark the rest `"Not executed"`, capture **one** observation at the end (settle-detected, not fixed sleep). No per-click screenshots.
- Settle: poll a cheap window capture every 100 ms until two frames match (or focused element / window changes), 1.5 s timeout.
- Persistent helper: `backboard-cua-helper` (Swift, compiled at build via `swiftc`, shipped in the release bundle; fallback to `swift -e` once with a warning) speaking JSON over stdio: `capture`, `ax`, `click`, `type`, `key`, `scroll`, `drag`, `settle`. Windows: one `powershell -NoExit` / C# host with `SendInput` + UIA `CacheRequest`.
- Multi-monitor: capture the display containing the focused window; offset AX bounds into that display's space; report `displayId`.
- Screenshot retention: delete session dir on exit or cap at 200 MB.

### Prompt (single source, both profiles)

Replace both copies with one module that says: coordinate space; what the observation contains and that `elementId` is preferred; that a batch ends with an automatic observation so don't queue `screenshot` after actions; "queue every step you are confident about, stop at the first uncertain one"; key naming (xdotool names, `meta` = ⌘/Win, chord strings accepted); prefer keyboard shortcuts and CLI/`Execute`/`Read` for files, PDFs, bulk text; confirm "after prep, before the irreversible action"; on failure read `error` and retry with a different target. Keep it under ~350 tokens — the schema carries the rest.

### Permissions

`isReadOnly` = every action is `screenshot|zoom|wait`. `summarizeInput` shows the batch ("click Save, type 'hello', key ctrl+s"). Persisted allow rules scope to action kinds (`Computer(click)`), not the whole tool.

### Order of work

1. C1 + C2 + prompt rewrite (one PR; fixes correctness, ~10× smaller payloads, 2–3× fewer model calls).
2. Tier-0/0.5 evals so 3–5 can be measured.
3. Persistent Swift helper + settle detection + scroll/drag/double-click.
4. `DaytonaPlatform` + Tier-1 suite.
5. Windows parity via the persistent host.

## Part 6 — What was built on this branch

Everything in Parts 1–5 that is marked below as *done* shipped in this branch; the bug table in Part 1 is resolved as noted.

### Architecture

```
ComputerTool (schema, aliases, permissions)
  └─ ComputerRuntime (batch semantics, settle, single observation, element refresh)
       ├─ ComputerObserver (one IPC → screenshot + a11y, JPEG ≤1280px, retention)
       └─ Platform
            ├─ MacPlatform   → HelperProcess → compiled Swift helper (ScreenCaptureKit, AX, CGEvent)
            ├─ WindowsPlatform → HelperProcess → persistent PowerShell host (SendInput, UIA CacheRequest)
            ├─ DaytonaPlatform (scripts/cua-eval) → @daytona/sdk computerUse (Linux XFCE)
            └─ FixturePlatform (scripts/cua-eval) → saved screenshot + elements, records clicks
```

- **Native helper, not per-call scripts.** `src/core/platform/mac/cuaHelper.swift` is embedded as text, compiled once with `swiftc` into `~/.backboard/bin/cua-helper-<hash>` (2.4 s, cached by source hash), and kept alive as a JSON-lines process. Windows uses the same protocol via `windows/cuaHelper.ps1` in a `-NoProfile` host that stays open. `HelperProcess` handles ids, timeouts, abort, crash → respawn.
- **Point space everywhere.** The helper reports the display that holds the frontmost window, in points, and downscales the capture itself (`screenSize` = points, `imageSize` = pixels sent, `scale` = ratio). Fixes C1 and M1.
- **Batch semantics** (Anthropic/OpenAI style): run in order, stop at first failure, remaining actions come back `skipped: true`, then *one* settle (frame-diff poll, 1.2 s / 3 s after openApp) and *one* observation that carries the only image in the payload. Fixes C2 and M7.
- **Element ids survive a batch.** After any state-changing action, an `elementId` target re-reads the accessibility tree (~20 ms) and re-matches by role+name or overlap before clicking, so `[click field, type, click Save]` lands on Save even when the layout shifted. Fixes H1.
- **Action set**: `screenshot, zoom{region}, click{count,button,modifiers}, move, drag, scroll{direction,amount}, type, key{repeat}, holdKey, wait, openApp`. Provider dialects (`left_click`, `coordinate:[x,y]`, `keypress{keys}`, `scroll_y`, `duration` seconds, `type:` instead of `action:` …) are normalized in `ComputerTool.normalizeComputerInput`. Fixes H2, H6 (full key table, xdotool-style names, chord strings).
- **Accessibility**: focused window only (plus attached sheets/dialogs *and* the main window when a sheet is focused), interactive-role whitelist, on-screen bounds only, ≤80 elements, no per-element app metadata, real window title, `focusedElementId`, `modal`, and `trusted:false` when the permission is missing. Fixes H3.
- **Keyboard layout**: character keys are resolved through the active layout with `UCKeyTranslate`; this machine runs Colemak, where a QWERTY key-code table sent ⌘K for `cmd+n`. Modifier chords post real modifier key-down/up events, because setting flags on the key event alone leaves ⌘ "held" in the window server for every later event. Fixes H5-adjacent correctness.
- **Prompt**: one module (`prompts/tools/computer.tsx`) rendered by both profiles; states the coordinate space, that the final screen is attached (no trailing screenshot), batching guidance, key format, prefer-CLI guidance, and the confirm-before-irreversible rule. Fixes M5, M6.
- **Permissions**: `isReadOnly` when every action is `screenshot|zoom|wait|move`; `summarizeInput` renders the batch in the prompt; `permissionHint` flags credential-looking text. Fixes M2.
- **Retention**: per-session cap 50 MB, other sessions pruned after 7 days. Fixes M3. Abort-safe `delay`. Fixes M4.
- **Windows** ships `type`/`key`/`scroll`/`drag` through `SendInput` (fixes C3) — written against the documented APIs but **not executed on a Windows machine in this branch**; treat as needing a first run there.

### Measured on this machine (macOS 26, M-series, 1920×1080 external + Retina internal)

| Operation | Before | After |
|---|---|---|
| a11y snapshot | `swift -e`: 1363 ms cold / 332 ms warm | helper `ax`: ~20–60 ms |
| click / key / type | `osascript`: ~355 ms each | CGEvent via helper: 2–25 ms |
| screenshot + a11y + encode | `screencapture` + `sips` + swift: ~1.9 s | one `observe` IPC: 55–90 ms (JPEG q85 @1280, ~130 KB) |
| zoom region | n/a | 41–57 ms |
| settle after typing | fixed 300 ms | frame-diff: 240–350 ms, exits early when static |
| batch `openApp → cmd+n` incl. settle + observation | ~4 s+ | 1.3–3.5 s (dominated by app launch) |
| payload per call | up to 21 images | exactly 1 image, ~130–150 KB |

`scripts/cua-smoke.ts` output on this branch: open TextEdit + ⌘N (1.3–3.5 s), type sentence + ⌘A (0.39 s, text verified in the `TextArea` element), zoom (0.05 s), scroll + move (0.3 s), ⌘W then click the sheet's *Delete* button by `elementId` — **SMOKE PASSED**.

### Evals (all runnable from `package.json`)

| Tier | Command | What ran | Result |
|---|---|---|---|
| unit | `bun test` | 1430 tests incl. 60+ for the tool, runtime, keys, paths, helper process | pass |
| e2e (mac) | `bun run cua:e2e` | compile + cache helper, point-space capture, zoom, a11y, settle, cursor move | 5/5 pass, 3.6 s |
| smoke (mac) | `bun run cua:smoke` | real app flow above | pass |
| Tier 0 | `bun run cua:grounding` | 8 Calculator fixtures (6 element-id, 2 coordinate-only) through the real agent loop | **8/8**, 7–13 s each, gpt-5.5 |
| Tier 1 | `bun run cua:eval -f editor-save-hello,terminal-create-dir` | fresh Daytona XFCE sandbox per task, real agent loop with Computer + Execute, programmatic checker | **2/2**: 8 rounds / 5 Computer calls / 64 s; 6 rounds / 4 calls / 57 s |
| Tier 1 full | `bun run cua:eval -c 3` | 10 tasks (editor ×3, terminal, settings ×2, web ×2, multi ×2), fresh sandbox each, gpt-5.5 | **9/10** across the runs below; `web-read-and-record` is the open one |

Full-suite run (first pass, before the harness fixes below): 6/10 — 86 rounds, 66 Computer calls, 95 actions (1.44 actions/call), 64 images, 18 min wall for ~1,076 s of sandbox time, 3.6M input tokens (~25–30k per round). The four failures were all **harness bugs, not agent bugs**, and each was diagnosed in a live sandbox:

1. The desktop is `DISPLAY=:0`, not `:1` (the docs' example), and the process API passes no session environment — `xfce4-settings-manager` launched by the agent wrote to a throwaway xfconfd. Fix: read `DISPLAY`/`DBUS_SESSION_BUS_ADDRESS`/XDG vars from the live `xfce4-session` and export them in every exec. Both settings tasks then passed (7 rounds/4 calls/62 s; 13 rounds/10 calls/97 s).
2. Ubuntu-style `firefox` is a snap stub; the image is Debian 13 with `chromium` preinstalled, which needs `--no-sandbox --disable-gpu --disable-dev-shm-usage` in a container and `GTK_MODULES=gail:atk-bridge` + `--force-renderer-accessibility` to appear in AT-SPI. The AT-SPI walk must also start from the active application frame, not the desktop root (the panel exhausted the element budget). `web-form-submit` then passed (5 rounds/4 calls/129 s — the model filled the form through a `javascript:` bookmarklet in the address bar).
3. `apt-cache`/`--version` probes must ignore snap stubs; `sudo -n` is required (non-root `daytona` user).

Two agent-behaviour findings worth acting on: with no elements in the tree the model **reported "Filled and submitted the signup form" when nothing had been submitted** (only the programmatic checker caught it), and on the open task it burned all 20 rounds cycling through bookmarklets, terminals, and `F11` instead of using the `Execute` tool it had. Both argue for the eval's checker-based scoring and for prompt work on "verify before claiming done". `web-read-and-record` stays red after three attempts (11–20 rounds each): once it saved the page `<title>` instead of the `<h1>` (the page was then disambiguated), once it wrote an empty file and reported success. Chromium's page content still does not surface in AT-SPI despite `--force-renderer-accessibility`, so the browser tasks run screenshot-only — the Browser tool (CDP) remains the better path for web work.

Fixtures are cropped to the app window (`capture-fixture.ts --window`) so nothing else on the screen is committed.

### BYOK image path (found in real use)

Running `/cua` with `openrouter/x-ai/grok-4.6` failed after three calls with *"maximum prompt length is 500000 but the request contains 591994 tokens"*. Backboard's server lifts `__image_base64` out of tool outputs into image blocks; the BYOK adapters never did, so every screenshot went to the model as ~175 KB of base64 **text** (~50k tokens, and no picture). `src/providers/byok/toolImages.ts` now strips image payloads from tool JSON and each adapter attaches them natively — Anthropic `tool_result` image blocks, OpenAI/OpenRouter a follow-up user message with `image_url` parts (tool messages are text-only), Gemini `inlineData` parts — keeping only the last 3 screenshots as images (older results say `"omitted: older screenshot"`), which is the interval-pruning pattern from Part 3.6. Grounding fixtures via BYOK after the fix: grok-4.6 (OpenRouter) 8/8 at ~5.5k tokens per fixture; claude-sonnet-5 (Anthropic direct) 8/8 at ~7k.

The same session also surfaced that xAI rejects `exclusiveMinimum: true` in tool schemas (zod `.positive()` under the OpenAPI-3 target) — fixed with `.min(1)` and a registry-wide test; `scripts/verify-tool-schemas.ts` now sends every tool schema to every configured backend (18/18 pass).

### Not done / next

- Windows helper needs its first run on a Windows machine.
- `DaytonaPlatform` approximates modifier-clicks and horizontal scroll (SDK has no primitives).
- Interval-based image pruning / cache breakpoints live server-side; verify the server does not re-send every screenshot per turn (each Tier-1 round cost ~25–30k input tokens).
- Speculative next-action prediction and learned macros (Part 3.4) are not started.
