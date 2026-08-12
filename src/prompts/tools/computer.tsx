import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Use the local computer through screenshots and direct actions.
Take a screenshot before acting unless the current observation is fresh.
Prefer elementId targets when available; use coordinates only as fallback.
After a state-changing action, inspect the result.
Ask the user before sensitive actions such as submitting forms, purchases, deletion, credentials, or payments.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`actions\` | \`array\` | yes | Serial queue of 1-20 Computer action objects. |
| \`defaultDelayMs\` | \`number\` | no | Delay between queued actions. |
| \`stopOnError\` | \`boolean\` | no | Stop queued execution after the first failed action. |

### Actions

| Action | Required fields | Optional fields |
| --- | --- | --- |
| \`screenshot\` | \`action\` | _none_ |
| \`click\` | \`action\`, \`elementId\` or \`x\` and \`y\` | \`target\`, \`button\` |
| \`type\` | \`action\`, \`text\` | _none_ |
| \`key\` | \`action\`, \`key\` object | _none_ |
| \`wait\` | \`action\`, \`durationMs\` or \`ms\` | _none_ |
| \`openApp\` | \`action\`, \`appName\` | _none_ |`.trim(),
);
