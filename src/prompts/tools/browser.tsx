import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`Use Browser for Chromium tab automation through screenshots and direct page actions.
Use navigate for URLs instead of typing them into the address bar.
Take a screenshot before clicking elementId targets unless the current observation is fresh.
Prefer elementId targets when available; use coordinates only as fallback.
For keyboard input, use key actions like { action: "key", key: "k" }.
Ask the user before sensitive actions such as submitting forms, purchases, deletion, credentials, or payments.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`actions\` | \`array\` | yes | Serial queue of 1-20 Browser action objects. |
| \`defaultDelayMs\` | \`number\` | no | Delay between queued actions. |
| \`stopOnError\` | \`boolean\` | no | Stop queued execution after the first failed action. |

### Actions

| Action | Required fields | Optional fields |
| --- | --- | --- |
| \`screenshot\` | \`action\` | _none_ |
| \`navigate\` | \`action\`, \`url\` | _none_ |
| \`click\` | \`action\`, \`elementId\` or \`x\` and \`y\` | \`target\`, \`button\` |
| \`type\` | \`action\`, \`text\` | _none_ |
| \`key\` | \`action\`, \`key\` | \`modifiers\` |
| \`wait\` | \`action\`, \`durationMs\` or \`ms\` | _none_ |`.trim(),
);
