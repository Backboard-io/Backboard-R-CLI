import { z } from "zod";
import type { PermissionDecision } from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";

/** Upper bound on questions per call — keeps the breadcrumb and the
 * confirm-each flow manageable, matching the "chain a few related decisions"
 * guidance in the prompt. */
const MAX_QUESTIONS = 4;

const questionSchema = z.object({
	// `header` is required here (the model should always title a question), even
	// though AskUserQuestionSpec.header is optional — that optionality exists only
	// for the headerless single-question `askUser` shim in AgentController.
	header: z
		.string()
		.describe(
			"Short title for this question, shown in the breadcrumb at the top",
		),
	question: z.string().describe("The question to ask the user"),
	options: z
		.array(z.string())
		.min(1)
		.max(4)
		.describe("Mutually exclusive options to present (2-4 recommended)"),
});

const schema = z.object({
	questions: z
		.array(questionSchema)
		.min(1)
		.max(MAX_QUESTIONS)
		.describe(
			`One or more related questions to ask in a single prompt (max ${MAX_QUESTIONS})`,
		),
});

type Input = z.infer<typeof schema>;
type Question = z.infer<typeof questionSchema>;

interface AnsweredQuestion {
	header: string;
	question: string;
	answer: string;
}

interface Output {
	answers: AnsweredQuestion[];
}

export class AskUserTool extends Tool<Input, Output> {
	readonly name = "AskUser";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override isConcurrencySafe(): boolean {
		return false;
	}

	override checkPermissions(): PermissionDecision | undefined {
		return { behavior: "allow", reason: "internal tool" };
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const questions = input.questions;
		const rawAnswers = await this.collectAnswers(questions, ctx);

		const answers: AnsweredQuestion[] = questions.map((q, index) => ({
			header: q.header,
			question: q.question,
			answer: rawAnswers[index] ?? "",
		}));

		return ok(
			{ answers },
			this.summarize(answers),
			this.title(questions, answers),
		);
	}

	private async collectAnswers(
		questions: Question[],
		ctx: ToolContext,
	): Promise<string[]> {
		if (ctx.askQuestions) {
			return ctx.askQuestions(
				questions.map((q) => ({
					header: q.header,
					question: q.question,
					options: q.options,
				})),
			);
		}
		// Fallback for contexts that only support single questions.
		const answers: string[] = [];
		for (const q of questions) {
			answers.push(await ctx.askUser(q.question, q.options));
		}
		return answers;
	}

	private summarize(answers: AnsweredQuestion[]): string {
		// Keep the full question in the model-visible result so the answer stays
		// attributable, not just the terse header.
		return answers
			.map((a) => {
				const label = a.header ? `[${a.header}] ${a.question}` : a.question;
				return `${label}: ${a.answer}`;
			})
			.join("\n");
	}

	private title(questions: Question[], answers: AnsweredQuestion[]): string {
		if (answers.length === 1) {
			const only = answers[0];
			const question = questions[0];
			if (!only || !question) return "Answered";
			return question.options.includes(only.answer)
				? `Selected: ${only.answer}`
				: `Answered: ${only.answer}`;
		}
		return `Answered ${answers.length} questions`;
	}
}
