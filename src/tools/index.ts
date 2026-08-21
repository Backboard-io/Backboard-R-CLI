import {
	createRuntimeThinkingResolver,
	resolveRuntimeThinking,
} from "../config/thinkingRuntime.ts";
import { LocalReplExecutor } from "../core/agent/rlm/LocalReplExecutor.ts";
import { RLMLoop } from "../core/agent/rlm/RLMLoop.ts";
import { SubAgentRunner } from "../core/agent/SubAgentRunner.ts";
import { AgentCatalog } from "../core/agents/AgentCatalog.ts";
import { BUILT_IN_AGENTS } from "../core/agents/builtin.ts";
import type { Tool } from "../core/tools/Tool.ts";
import { ToolRegistry } from "../core/tools/ToolRegistry.ts";
import { AgentTool } from "./AgentTool.tsx";
import {
	DEFAULT_AGENT_MAX_CONCURRENT,
	DEFAULT_AGENT_MAX_DEPTH,
} from "./AgentToolConstants.ts";
import type { DefaultToolDeps } from "./AgentToolTypes.ts";
import { ApplyPatchTool } from "./ApplyPatchTool.tsx";
import { AskUserTool } from "./AskUserTool.tsx";
import { BrowserTool } from "./BrowserTool.tsx";
import { ComputerTool } from "./ComputerTool.tsx";
import { selectDelegatableTools } from "./delegatableTools.ts";
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

const BUILT_IN_CATALOG = new AgentCatalog(BUILT_IN_AGENTS);

function buildAgentTool(deps: DefaultToolDeps, base: Tool[]): AgentTool {
	const holder: { tool?: AgentTool } = {};
	const getCatalog = () => deps.getAgentCatalog?.() ?? BUILT_IN_CATALOG;

	// Sub-agents are where implementation happens, so they run on the execution
	// model and against the delegated policy — expert mode narrows the parent,
	// never the worker that has to do the work.
	const executionView = () => ({
		model: deps.config.executionModel,
		thinkingIntent: deps.config.executionThinking,
	});

	const runner = new SubAgentRunner({
		client: deps.client,
		getModel: () => deps.config.executionModel,
		memory: deps.config.memory,
		memoryProfile: deps.config.memoryProfile,
		getThinking: () => resolveRuntimeThinking(executionView(), deps.client),
		getThinkingResolver: () =>
			createRuntimeThinkingResolver(executionView(), deps.client),
		toolFactory: ({ definition }) => {
			const registry = new ToolRegistry([...(deps.getTools?.() ?? base)]);
			return selectDelegatableTools({
				definition,
				candidates: deps.config.delegatedToolPolicy.visibleTools(registry),
				agentTool: holder.tool,
				isToolEnabled: (name) => deps.config.isDelegatedToolEnabled(name),
			});
		},
		isToolEnabled: (name) => deps.config.isDelegatedToolEnabled(name),
		hookController: deps.hookController,
		lsp: deps.lsp,
		checkpoints: deps.checkpoints,
	});

	const agent = new AgentTool({
		runner,
		getCatalog,
		maxDepth: DEFAULT_AGENT_MAX_DEPTH,
		maxConcurrent: DEFAULT_AGENT_MAX_CONCURRENT,
		...(deps.backgroundSupervisor
			? { supervisor: deps.backgroundSupervisor }
			: {}),
		createRLMLoop: (definition) =>
			new RLMLoop({
				client: deps.client,
				model: definition.model ?? deps.config.executionModel,
				executor: new LocalReplExecutor(),
				...(definition.systemPrompt
					? { instructions: definition.systemPrompt }
					: {}),
				...(definition.maxRounds !== undefined
					? { maxIterations: definition.maxRounds }
					: {}),
			}),
	});
	holder.tool = agent;
	return agent;
}
