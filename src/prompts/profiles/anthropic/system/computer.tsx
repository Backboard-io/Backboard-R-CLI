import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`
Computer use is enabled. You have one more tool:
- Computer: watch and control the local machine via screenshots and actions.

Act only on what you can currently see. After you open an app or change the UI, capture or read a fresh screenshot before choosing the next step. Keep acting on your successes; never claim you cannot control the screen.
`.trim(),
);
