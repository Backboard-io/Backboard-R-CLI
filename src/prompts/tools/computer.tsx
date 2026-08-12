import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Observe and control the local computer through a queue of 1-20 actions: screenshot, click (by elementId or x/y), type, key, wait, openApp.

- Act on a fresh screenshot, and after any action that changes state, look again before choosing the next one. Prefer element IDs from the latest screenshot; coordinates are a fallback.
- Queue only the actions for the immediate step; set stopOnError so a failed action halts the rest.
- Get the user's approval before anything sensitive or irreversible: submitting forms, payments, deletions, entering credentials, changing settings.`,
);
