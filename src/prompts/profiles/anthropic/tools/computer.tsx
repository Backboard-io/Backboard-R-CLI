import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const computer: PromptModule = definePrompt(
	`Observe and drive the local computer through screenshots and direct actions.
Take a screenshot before acting unless your last observation is still current.
Target elementId when you have it; fall back to x/y coordinates only when you must.
After any state-changing action, read the result before you continue.
Get the user's approval before anything sensitive or irreversible: form submissions, purchases, deletions, credentials, or payments.

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
