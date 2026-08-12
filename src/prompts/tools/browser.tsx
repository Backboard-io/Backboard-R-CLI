import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`Drive a Chromium tab through a queue of 1-20 actions: screenshot, navigate (url), click (by elementId or x/y), type, key (with optional modifiers), wait.

- Open pages with navigate, not by typing into the address bar. Act on a fresh screenshot, and after any action that changes the page, look again before the next one. Prefer element IDs; coordinates are a fallback.
- Queue only the actions for the immediate step; set stopOnError so a failed action halts the rest.
- Get the user's approval before anything sensitive or irreversible: submitting forms, payments, deletions, entering credentials.`,
);
