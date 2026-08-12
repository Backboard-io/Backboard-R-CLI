import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const askUser: PromptModule = definePrompt(
	`Ask the user one or more multiple-choice questions mid-task to pin down requirements or decisions before you commit to an approach.

When to use:
- Ask only when the answer changes what you build; resolve everything else from the request, the code, or sensible defaults.
- Prefer a single call with several \`questions\` over many separate interruptions. Chain related decisions the user would naturally settle together (e.g. framework, styling, and state management for a new feature) so they answer them in one pass.
- Order the questions so the most load-bearing one comes first — its answer often narrows or settles the others.

Writing good questions:
- Give every question a short \`header\` (2-4 words, e.g. "Auth method", "Storage"). Headers form a breadcrumb at the top so the user can see the whole set at a glance.
- Keep each \`question\` short and tightly scoped, with 2-4 mutually exclusive \`options\`. The user can always type their own answer, so never add an "other" option.
- If you have not already laid out the context and trade-offs, put that context in the question text so the choice stands on its own. Keep option labels short but make the question self-explanatory.

The user navigates with ←/→ between questions and ↑/↓ to choose, and must confirm every question before submitting — so lead each option list with a safe default.

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`questions\` | \`array\` | yes | 1-4 related questions to ask together |
| \`questions[].header\` | \`string\` | yes | Short title (2-4 words) shown in the breadcrumb |
| \`questions[].question\` | \`string\` | yes | The question to ask the user |
| \`questions[].options\` | \`array\` | yes | 1-4 mutually exclusive options (2-4 recommended) |`.trim(),
);
