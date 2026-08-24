import type { ModelRef } from "../../config/defaults.ts";
import type { AgentMode } from "../tools/AgentToolOutput.ts";

export type AgentSource = "built-in" | "project" | "user";

export interface AgentDefinition {
	name: string;
	description: string;
	mode: AgentMode;
	/** Replaces the default sub-agent system prompt. */
	systemPrompt: string;
	/** Allowlist of delegatable tool names; undefined inherits the parent's set. */
	tools?: readonly string[];
	disallowedTools?: readonly string[];
	/** Overrides the parent's model for this agent's turns. */
	model?: ModelRef;
	maxRounds?: number;
	/** Wall-clock budget for one run; on expiry the agent summarizes partial work. */
	timeoutMs?: number;
	/** Run past the spawning turn and report back later. Top-level worker spawns only. */
	background?: boolean;
	source: AgentSource;
	path?: string;
}
