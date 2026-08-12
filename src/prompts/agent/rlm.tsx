import type {
	JSONValue,
	RLMExecObservation,
	RLMTrajectoryEntry,
} from "../../core/agent/rlm/RLMTypes.ts";

export const RLM_MISSING_CODE_MESSAGE =
	"[Error] No JavaScript code block found. Return exactly one fenced ```js code block or call SUBMIT(...) from code.";

export function rlmActionPrompt(input: {
	prompt: string;
	variables: Record<string, JSONValue>;
	trajectory: RLMTrajectoryEntry[];
	iteration: number;
	maxIterations: number;
	maxOutputChars: number;
}): string {
	return [
		"You are controlling a JavaScript REPL to answer the user's request.",
		"Write exactly one fenced ```js code block. Do not call external/provider tools.",
		"The full user request is stored in the REPL variable `context`.",
		"Structured input variables are available as `inputs`, and valid non-reserved names are also bound directly.",
		"Use `print(...)` or `console.log(...)` to inspect values; only printed stdout is shown back to you.",
		"Use `inspect(value)` to format JSON-like values before printing.",
		"Use `state` to persist data across iterations.",
		"Use `await llm_query(prompt)` or `await llm_query_batched(prompts)` for recursive sub-LM calls.",
		"Call `SUBMIT(answer)` from code when done. `answer` may be a string or JSON-serializable object.",
		`Iteration: ${input.iteration + 1}/${input.maxIterations}.`,
		`Max output characters per REPL result: ${input.maxOutputChars}.`,
		"",
		"Variable metadata:",
		formatVariableInfo(input.prompt, input.variables),
		"",
		"REPL history:",
		formatTrajectory(input.trajectory),
	].join("\n");
}

export function rlmExtractPrompt(
	prompt: string,
	trajectory: RLMTrajectoryEntry[],
): string {
	return [
		"The RLM loop ended before SUBMIT was called.",
		"Produce the best final answer supported by the user request and REPL trajectory.",
		"",
		"User request:",
		prompt,
		"",
		"REPL trajectory:",
		formatTrajectory(trajectory),
	].join("\n");
}

export function rlmTimedOutSummaryPrompt(input: {
	prompt: string;
	trajectory: RLMTrajectoryEntry[];
	timeoutMs: number;
	reason: string;
}): string {
	return [
		`The RLM wall-clock budget expired after ${Math.ceil(input.timeoutMs / 1000)} seconds.`,
		"Produce a concise partial-progress report for the parent agent.",
		"Do not request tools. Do not include new code. Only summarize what is supported by the trajectory.",
		"Include what was explored, concrete findings, what remains unresolved, and the best next step.",
		"",
		"Timeout reason:",
		input.reason,
		"",
		"User request:",
		input.prompt,
		"",
		"REPL trajectory:",
		formatTrajectory(input.trajectory),
	].join("\n");
}

export function rlmNativeToolCallMessage(names: string[]): string {
	return `[Error] Native provider tool calls are not available inside RLM (${names.join(", ")}). Use JavaScript code, provided input variables, llm_query/llm_query_batched, and SUBMIT(...) instead.`;
}

export function rlmExecutionResultMessage(
	result: RLMExecObservation,
	maxOutputChars: number,
): string {
	if ("submitted" in result) {
		const parts = [];
		if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
		parts.push(`SUBMIT: ${formatSubmitted(result.submitted ?? null)}`);
		const joined = parts.join("\n");
		return joined.length > maxOutputChars
			? `${joined.slice(0, maxOutputChars)}\n[truncated]`
			: joined;
	}
	const parts = [`Execution ${result.ok ? "ok" : "error"}.`];
	const stdout = result.stdout || "(no output - did you forget to print?)";
	if (stdout) parts.push(`stdout:\n${stdout}`);
	if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
	const joined = parts.join("\n");
	return joined.length > maxOutputChars
		? `${joined.slice(0, maxOutputChars)}\n[truncated]`
		: joined;
}

export function rlmSubmittedReport(value: JSONValue): string {
	return formatSubmitted(value);
}

function formatVariableInfo(
	prompt: string,
	variables: Record<string, JSONValue>,
): string {
	const preview =
		prompt.length > 2_000 ? `${prompt.slice(0, 2_000)}\n...` : prompt;
	return [
		"- context",
		"  type: string",
		`  length: ${prompt.length}`,
		"  preview:",
		indent(preview),
		"- inputs",
		"  type: object",
		"  keys:",
		indent(
			Object.keys(variables).length === 0
				? "(none)"
				: Object.keys(variables).join(", "),
		),
		...Object.entries(variables).map(([name, value]) =>
			formatVariablePreview(name, value),
		),
	].join("\n");
}

function formatVariablePreview(name: string, value: JSONValue): string {
	const text = formatSubmitted(value);
	const preview = text.length > 1_000 ? `${text.slice(0, 1_000)}\n...` : text;
	return [
		`- ${name}`,
		`  type: ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`,
		"  preview:",
		indent(preview),
	].join("\n");
}

function formatTrajectory(trajectory: RLMTrajectoryEntry[]): string {
	if (trajectory.length === 0) return "(empty)";
	return trajectory
		.map((entry, index) =>
			[
				`Step ${index + 1}`,
				entry.reasoning ? `Reasoning:\n${indent(entry.reasoning)}` : "",
				`Code:\n${indent(entry.code || "(no code)")}`,
				`Output:\n${indent(entry.output || "(no output)")}`,
			]
				.filter(Boolean)
				.join("\n"),
		)
		.join("\n\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
}

function formatSubmitted(value: JSONValue): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}
