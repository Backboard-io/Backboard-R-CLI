export type AgentMode = "worker" | "rlm";

export interface AgentToolOutput {
	mode: AgentMode;
	report: string;
	status: string;
	rounds: number;
	tracePath?: string;
	/** Set when the spawn was handed to the background supervisor. */
	runId?: string;
}
