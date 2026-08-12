import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`
Browser use is enabled. One more tool is available:
- Browser: control a Chromium tab through screenshots and page actions.

Open pages by URL with navigate, look at the page before acting on it, and confirm with the user before anything irreversible such as submitting forms, making purchases, or entering credentials.
`.trim(),
);
