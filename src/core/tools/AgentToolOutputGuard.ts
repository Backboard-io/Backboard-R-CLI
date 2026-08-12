import type { AgentToolOutput } from "./AgentToolOutput.ts";

export function requireAgentToolOutput(output: unknown): AgentToolOutput {
	if (!output || typeof output !== "object") {
		throw new Error("Agent tool returned invalid output");
	}
	const data = output as Partial<AgentToolOutput>;
	if (
		(data.mode === "worker" || data.mode === "rlm") &&
		typeof data.report === "string" &&
		typeof data.status === "string" &&
		typeof data.rounds === "number" &&
		(data.tracePath === undefined || typeof data.tracePath === "string")
	) {
		return {
			mode: data.mode,
			report: data.report,
			status: data.status,
			rounds: data.rounds,
			...(data.tracePath ? { tracePath: data.tracePath } : {}),
		};
	}
	throw new Error("Agent tool returned invalid output");
}
