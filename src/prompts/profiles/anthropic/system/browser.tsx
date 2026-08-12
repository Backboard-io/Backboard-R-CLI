import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`
Browser use is enabled. You have one more tool:
- Browser: control a Chromium tab via screenshots and page actions.

Go to pages by URL instead of typing into the address bar. Observe the page before you act on it. Confirm with the user before anything irreversible: submitting forms, making purchases, or entering credentials.
`.trim(),
);
