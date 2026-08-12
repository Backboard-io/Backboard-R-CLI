import {
	createRuntimeThinkingResolver,
	resolveRuntimeThinking,
} from "../config/thinkingRuntime.ts";
import { LocalReplExecutor } from "../core/agent/rlm/LocalReplExecutor.ts";
import { RLMLoop } from "../core/agent/rlm/RLMLoop.ts";
import { SubAgentRunner } from "../core/agent/SubAgentRunner.ts";
import type { Tool } from "../core/tools/Tool.ts";
import { ToolRegistry } from "../core/tools/ToolRegistry.ts";
import { subagent as subagentPrompt } from "../prompts/system/subagent.tsx";
import { AgentTool } from "./AgentTool.tsx";
import {
	DEFAULT_AGENT_MAX_DEPTH,
	NON_DELEGATABLE_AGENT_TOOLS,
} from "./AgentToolConstants.ts";
import type { DefaultToolDeps } from "./AgentToolTypes.ts";
import { ApplyPatchTool } from "./ApplyPatchTool.tsx";
import { AskUserTool } from "./AskUserTool.tsx";
import { BrowserTool } from "./BrowserTool.tsx";
import { ComputerTool } from "./ComputerTool.tsx";
import { EditTool } from "./EditTool.tsx";
import { ExecuteTool } from "./ExecuteTool.tsx";
import { FetchUrlTool } from "./FetchUrlTool.tsx";
import { FindMcpTool } from "./FindMcpTool.tsx";
import { FindSkillTool } from "./FindSkillTool.tsx";
import { GlobTool } from "./GlobTool.tsx";
import { GrepTool } from "./GrepTool.tsx";
import { ReadTool } from "./ReadTool.tsx";
import { TodoWriteTool } from "./TodoWriteTool.tsx";
import { WebSearchTool } from "./WebSearchTool.tsx";
import { WriteTool } from "./WriteTool.tsx";

function createBaseTools(): Tool[] {
	return [
		new ReadTool(),
		new WriteTool(),
		new EditTool(),
		new ApplyPatchTool(),
		new ExecuteTool(),
		new GrepTool(),
		new GlobTool(),
		new FetchUrlTool(),
		new WebSearchTool(),
		new AskUserTool(),
		new TodoWriteTool(),
		new ComputerTool(),
		new BrowserTool(),
	];
}

/**
 * The default tool set for the coding profile. When `deps` are supplied the
 * recursive `Agent` tool is included; without them (e.g. in unit tests that do
 * not need sub-agents) only the base tools are returned.
 */
export function createDefaultTools(deps?: DefaultToolDeps): Tool[] {
	const base = createBaseTools();
	if (!deps) return base;
	const tools: Tool[] = [...base, buildAgentTool(deps, base)];
	if (deps.skillController) {
		tools.push(new FindSkillTool(deps.skillController));
	}
	if (deps.getMcpRegistrar) {
		tools.push(new FindMcpTool(deps.getMcpRegistrar));
	}
	return tools;
}

function buildAgentTool(deps: DefaultToolDeps, base: Tool[]): AgentTool {
	const holder: { tool?: AgentTool } = {};

	const runner = new SubAgentRunner({
		client: deps.client,
		getModel: () => deps.config.model,
		memory: deps.config.memory,
		memoryProfile: deps.config.memoryProfile,
		getThinking: () => resolveRuntimeThinking(deps.config, deps.client),
		getThinkingResolver: () =>
			createRuntimeThinkingResolver(deps.config, deps.client),
		systemPrompt: subagentPrompt.prompt,
		toolFactory: () => {
			const tools: Tool[] = [];
			const availableTools = (deps.getTools?.() ?? base).filter(
				(tool) => tool !== holder.tool,
			);
			const registry = new ToolRegistry([...availableTools]);
			const workerBaseTools = deps.config.toolPolicy.visibleTools(registry);
			for (const tool of workerBaseTools) {
				if (!NON_DELEGATABLE_AGENT_TOOLS.has(tool.agentName)) tools.push(tool);
			}
			if (holder.tool && deps.config.isToolEnabled(holder.tool.agentName)) {
				tools.push(holder.tool);
			}
			return tools;
		},
		isToolEnabled: (name) => deps.config.isToolEnabled(name),
		hookController: deps.hookController,
		lsp: deps.lsp,
		checkpoints: deps.checkpoints,
	});

	const agent = new AgentTool({
		runner,
		maxDepth: DEFAULT_AGENT_MAX_DEPTH,
		createRLMLoop: () =>
			new RLMLoop({
				client: deps.client,
				model: deps.config.model,
				executor: new LocalReplExecutor(),
			}),
	});
	holder.tool = agent;
	return agent;
}
