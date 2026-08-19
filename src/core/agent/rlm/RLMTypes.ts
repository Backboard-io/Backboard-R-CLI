import type { ModelRef } from "../../../config/defaults.ts";
import type { AgentClient } from "../../../providers/AgentClient.ts";
import type { UsageInfo } from "../../bus/events.ts";

export type JSONValue =
	| string
	| number
	| boolean
	| null
	| JSONValue[]
	| { [key: string]: JSONValue };

export type JSONObject = { [key: string]: JSONValue };
export type SandboxValue = JSONValue | undefined;

export interface RLMDeps {
	client: Pick<AgentClient, "sendMessage">;
	model: ModelRef;
	executor: REPLExecutor;
	instructions?: string;
	maxIterations?: number;
	maxLLMCalls?: number;
	maxOutputChars?: number;
	timeoutSummaryMs?: number;
}

export interface RLMRunParams {
	prompt: string;
	signal: AbortSignal;
	timeoutMs?: number;
	variables?: JSONObject;
}

export interface RLMTrajectoryEntry {
	reasoning: string;
	code: string;
	output: string;
}

export interface RLMResult {
	report: string;
	status: "completed" | "cancelled" | "timed_out";
	usage: UsageInfo;
	rounds: number;
	trajectory: RLMTrajectoryEntry[];
}

export interface RLMExecObservation {
	ok: boolean;
	stdout: string;
	stderr: string;
	submitted?: JSONValue;
}

export interface LLMBridge {
	llm(prompt: string): Promise<string>;
	llmBatch(prompts: string[]): Promise<string[]>;
}

export interface REPLExecutor {
	init(input: {
		context: string;
		variables?: JSONObject;
		bridge: LLMBridge;
	}): Promise<void>;

	execute(input: {
		code: string;
		signal: AbortSignal;
		timeoutMs?: number;
	}): Promise<RLMExecObservation>;

	dispose(): Promise<void>;
}
