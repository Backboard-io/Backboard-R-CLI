import type { ToolRoundThinkingEvidence } from "../../config/thinking.types.ts";
import type { ToolOutput } from "../tools/ToolScheduler.ts";

export function summarizeToolRound(
	outputs: ToolOutput[],
): Omit<
	ToolRoundThinkingEvidence,
	"index" | "consecutiveFailureCount" | "maxUsed"
> {
	const hadToolError = outputs.some(
		(output) =>
			output.metadata?.error === true || output.output.startsWith("Error:"),
	);
	const hadNonZeroExit = outputs.some((output) =>
		hasNonZeroExitCode(output.output),
	);
	const hadTimeout = outputs.some((output) =>
		output.output.includes("[timed out]"),
	);
	const hadWriteOrExecute = outputs.some(
		(output) =>
			output.metadata?.readOnly === false ||
			output.metadata?.name.toLowerCase() === "execute",
	);
	const readOnlyOnly =
		outputs.length > 0 &&
		outputs.every((output) => output.metadata?.readOnly === true);
	return {
		readOnlyOnly,
		hadWriteOrExecute,
		hadToolError,
		hadNonZeroExit,
		hadTimeout,
	};
}

export function toolRoundFailed(outputs: ToolOutput[]): boolean {
	const summary = summarizeToolRound(outputs);
	return summary.hadToolError || summary.hadNonZeroExit || summary.hadTimeout;
}

function hasNonZeroExitCode(output: string): boolean {
	const match = /\bexit code:\s*(\d+)\b/i.exec(output);
	if (!match?.[1]) return false;
	return Number(match[1]) !== 0;
}
