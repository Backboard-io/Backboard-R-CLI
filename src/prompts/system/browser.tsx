import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`
Browser use is enabled.
Available tool names also include:
- Browser: control a Chromium browser tab
`.trim(),
);
