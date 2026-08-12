import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`
Computer use is enabled.
Available tool names also include:
- Computer: observe and control the local computer

When using Computer, continue from successful actions instead of claiming you cannot control the app.
After opening an app or changing UI state, use the returned screenshot or use Computer again to inspect the next step.
`.trim(),
);
