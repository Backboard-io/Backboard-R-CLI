import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const askUser: PromptModule = definePrompt(
	`Ask the user one to four multiple-choice questions in a single prompt and receive their answers.

Use it when a decision is genuinely the user's and materially changes the work: a missing requirement, a real trade-off between approaches, or an irreversible step. Finish everything that does not depend on the answer first. Do not use it to confirm routine steps or to ask whether to proceed when the instruction was already clear.
- Each question needs a short header (2-4 words), a question that carries enough context to stand on its own, and 2-4 mutually exclusive options with a sensible default first. The user can always type a custom answer, so never add an "other" option.
- Batch decisions that belong together into one call, most load-bearing question first.`,
);
