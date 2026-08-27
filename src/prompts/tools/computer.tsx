import { definePrompt, type PromptModule } from "../PromptModule.ts";

/**
 * Single source of truth for the Computer tool description. Both prompt
 * profiles render this; the OpenAI profile appends its parameter table.
 */
export function buildComputerPrompt(): string {
	return `Control the local computer: a batch of actions runs in order, then the tool returns the final screen once — a downscaled screenshot plus the frontmost window's interactive elements (id, role, name, bounds).

How to act:
- Batch every step you are confident about into one call (e.g. click field → type → key ENTER). Do not add a trailing screenshot: the final screen is always attached after the last action. Stop the batch where you would need to look before continuing.
- Coordinates are in the latest screenshot's screenSize space (origin top-left, points not image pixels). Prefer target.elementId from the elements list; use x/y only for things the list lacks. Use zoom to read small text or find precise coordinates in a region.
- Keys use chord strings: "ENTER", "cmd+s", "ctrl+shift+t", "F5". meta = Command on macOS and the Windows key on Windows. Prefer keyboard shortcuts and typing over navigating menus with the mouse.
- Prefer non-GUI tools when they fit: read or write files, run commands, and fetch pages with the other tools instead of clicking through the interface. Use openApp rather than searching for an app.
- When an action fails, read its error and its screenshot, then pick a different target or route; do not repeat the same action unchanged.
- Confirm with the user after the screen is ready and before the irreversible step: sending, submitting, purchasing, deleting, entering credentials, or changing system settings.`;
}

export const computer: PromptModule = definePrompt(buildComputerPrompt());
