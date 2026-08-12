import type { Config } from "../config/Config.ts";
import type { RLMLoop } from "../core/agent/rlm/RLMLoop.ts";
import type { JSONObject } from "../core/agent/rlm/RLMTypes.ts";
import type { SubAgentRunner } from "../core/agent/SubAgentRunner.ts";
import type { CheckpointRecorder } from "../core/checkpoints/CheckpointStore.ts";
import type { HookController } from "../core/hooks/index.ts";
import type { LspService } from "../core/lsp/index.ts";
import type { AgentMode } from "../core/tools/AgentToolOutput.ts";
import type { Tool } from "../core/tools/Tool.ts";
import type { AgentClient } from "../providers/AgentClient.ts";
import type { McpRegistrar } from "./FindMcpTool.tsx";
import type { SkillActivator } from "./FindSkillTool.tsx";

export type {
	AgentMode,
	AgentToolOutput,
} from "../core/tools/AgentToolOutput.ts";

export interface AgentToolInput {
	subagent_type?: AgentMode;
	prompt: string;
	variables?: JSONObject;
	timeout_ms?: number;
}

export interface AgentToolDeps {
	runner: Pick<SubAgentRunner, "run">;
	createRLMLoop: () => Pick<RLMLoop, "run">;
	maxDepth: number;
}

export interface DefaultToolDeps {
	client: AgentClient;
	config: Config;
	getTools?: () => readonly Tool[];
	hookController?: HookController;
	lsp?: LspService;
	skillController?: SkillActivator;
	getMcpRegistrar?: () => McpRegistrar | undefined;
	checkpoints?: CheckpointRecorder;
}
