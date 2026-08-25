export type AgentMode = "worker" | "rlm";

export interface SpawnedAgent {
	agent: string;
	status: string;
	rounds: number;
	runId?: string;
	children?: SpawnedAgent[];
}

export interface AgentToolOutput {
	mode: AgentMode;
	agent?: string;
	report: string;
	status: string;
	rounds: number;
	tracePath?: string;
	runId?: string;
	logPath?: string;
	children?: SpawnedAgent[];
}

export function formatSpawnTree(
	children: readonly SpawnedAgent[],
	indent = "  ",
): string {
	return children
		.map((child) => {
			const state =
				child.status === "backgrounded"
					? `still running in background${child.runId ? ` (${child.runId})` : ""}`
					: `${child.status}, ${child.rounds} ${child.rounds === 1 ? "round" : "rounds"}`;
			const nested = child.children?.length
				? `\n${formatSpawnTree(child.children, `${indent}  `)}`
				: "";
			return `${indent}- ${child.agent} — ${state}${nested}`;
		})
		.join("\n");
}
