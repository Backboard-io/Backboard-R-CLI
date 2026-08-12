import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const browser: PromptModule = definePrompt(
	`Drive a Chromium tab through screenshots and direct page actions.
Open pages with navigate instead of typing URLs into the address bar.
Take a screenshot before clicking an elementId target unless your last observation is still current.
Target elementId when you have it; fall back to x/y coordinates only when you must.
Send keystrokes as key actions, e.g. { action: "key", key: "k" }.
Get the user's approval before anything sensitive or irreversible: form submissions, purchases, deletions, credentials, or payments.

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
