import { describe, expect, it } from "bun:test";
import type { RLMRunParams } from "../src/core/agent/rlm/RLMLoop.ts";
import type { SubAgentRunParams } from "../src/core/agent/SubAgentRunner.ts";
import { AgentCatalog } from "../src/core/agents/AgentCatalog.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { BUILT_IN_AGENTS } from "../src/core/agents/builtin.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { AgentTool } from "../src/tools/AgentTool.tsx";

function baseCtx(): ToolContext {
	return {
		sessionId: "s",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
		agentDepth: 0,
	};
}

const ctx = baseCtx;

const RESEARCHER: AgentDefinition = {
	name: "researcher",
	description: "Reads only.",
	mode: "worker",
	systemPrompt: "You research.",
	tools: ["read", "grep"],
	model: { provider: "anthropic", model: "claude-opus-5" },
	maxRounds: 30,
	timeoutMs: 300_000,
	source: "project",
};

const ANALYST: AgentDefinition = {
	name: "analyst",
	description: "Crunches data in a REPL.",
	mode: "rlm",
	systemPrompt: "You analyze.",
	timeoutMs: 60_000,
	source: "project",
};

function makeTool(
	agents: AgentDefinition[],
	maxConcurrent = 8,
): {
	tool: AgentTool;
	workerCalls: SubAgentRunParams[];
	rlmCalls: RLMRunParams[];
	rlmDefinitions: AgentDefinition[];
	release: () => void;
} {
	const workerCalls: SubAgentRunParams[] = [];
	const rlmCalls: RLMRunParams[] = [];
	const rlmDefinitions: AgentDefinition[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});

	const tool = new AgentTool({
		runner: {
			run: async (params) => {
				workerCalls.push(params);
				await gate;
				return {
					report: "report",
					status: "completed" as const,
					usage: {},
					toolRounds: 1,
				};
			},
		},
		createRLMLoop: (definition) => ({
			run: async (params) => {
				rlmDefinitions.push(definition);
				rlmCalls.push(params);
				return {
					report: "rlm report",
					status: "completed" as const,
					usage: {},
					rounds: 1,
					trajectory: [],
				};
			},
		}),
		getCatalog: () => new AgentCatalog([...agents, ...BUILT_IN_AGENTS]),
		maxDepth: 2,
		maxConcurrent,
	});
	return { tool, workerCalls, rlmCalls, rlmDefinitions, release };
}

describe("AgentTool registry dispatch", () => {
	it("passes the resolved definition through to the runner", async () => {
		const { tool, workerCalls, release } = makeTool([RESEARCHER]);
		release();
		await tool.execute(
			{ prompt: "find callers", subagent_type: "researcher" },
			ctx(),
		);
		expect(workerCalls[0]?.definition).toEqual(RESEARCHER);
	});

	it("routes rlm-mode definitions to the REPL loop", async () => {
		const { tool, rlmCalls, workerCalls, release } = makeTool([ANALYST]);
		release();
		const result = await tool.execute(
			{ prompt: "crunch", subagent_type: "analyst" },
			ctx(),
		);
		expect(result.data.mode).toBe("rlm");
		expect(workerCalls).toHaveLength(0);
		expect(rlmCalls[0]?.timeoutMs).toBe(60_000);
	});

	it("hands the rlm factory the definition so it can apply model and rounds", async () => {
		const { tool, rlmDefinitions, release } = makeTool([
			{
				...ANALYST,
				model: { provider: "anthropic", model: "claude-opus-5" },
				maxRounds: 3,
			},
		]);
		release();
		await tool.execute({ prompt: "crunch", subagent_type: "analyst" }, ctx());

		expect(rlmDefinitions[0]?.systemPrompt).toBe("You analyze.");
		expect(rlmDefinitions[0]?.model).toEqual({
			provider: "anthropic",
			model: "claude-opus-5",
		});
		expect(rlmDefinitions[0]?.maxRounds).toBe(3);
	});

	it("lets an explicit timeout_ms override the definition budget", async () => {
		const { tool, rlmCalls, release } = makeTool([ANALYST]);
		release();
		await tool.execute(
			{ prompt: "crunch", subagent_type: "analyst", timeout_ms: 5_000 },
			ctx(),
		);
		expect(rlmCalls[0]?.timeoutMs).toBe(5_000);
	});

	it("does not deadlock when parallel chains all spawn nested agents", async () => {
		const catalog = new AgentCatalog([...BUILT_IN_AGENTS]);
		let tool!: AgentTool;
		let nested = 0;
		tool = new AgentTool({
			runner: {
				run: async ({ depth }) => {
					if (depth < 2) {
						await tool.execute(
							{ prompt: "nested" },
							{ ...baseCtx(), agentDepth: depth },
						);
						nested++;
					}
					return {
						report: "r",
						status: "completed" as const,
						usage: {},
						toolRounds: 1,
					};
				},
			},
			createRLMLoop: () => ({
				run: async () => {
					throw new Error("unused");
				},
			}),
			getCatalog: () => catalog,
			maxDepth: 2,
			maxConcurrent: 4,
		});

		const chains = Array.from({ length: 4 }, () =>
			tool.execute({ prompt: "top" }, baseCtx()),
		);
		const outcome = await Promise.race([
			Promise.all(chains).then(() => "completed"),
			new Promise((resolve) => setTimeout(() => resolve("deadlock"), 1_000)),
		]);

		expect(outcome).toBe("completed");
		expect(nested).toBe(4);
	});

	it("caps concurrent runs and queues the overflow", async () => {
		const { tool, workerCalls, release } = makeTool([RESEARCHER], 2);
		const runs = [1, 2, 3, 4].map(() =>
			tool.execute({ prompt: "go", subagent_type: "researcher" }, ctx()),
		);

		await Promise.resolve();
		await Promise.resolve();
		expect(workerCalls).toHaveLength(2);

		release();
		await Promise.all(runs);
		expect(workerCalls).toHaveLength(4);
	});
});
