import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`
Computer use is enabled. One more tool is available:
- Computer: observe and control the local machine through screenshots and batched actions.

Act on what the latest screenshot and element list show. Each Computer call returns the screen after its last action, so queue the whole next step in one call and look once. Prefer file, shell, and web tools whenever they can do the job without the GUI.
`.trim(),
);
