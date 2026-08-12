import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`
Computer use is enabled. One more tool is available:
- Computer: observe and control the local machine through screenshots and actions.

Act only on what the latest screenshot shows. After opening an app or changing the screen, capture or read a fresh screenshot before the next step. Build on actions that worked; do not conclude that the screen is out of reach.
`.trim(),
);
