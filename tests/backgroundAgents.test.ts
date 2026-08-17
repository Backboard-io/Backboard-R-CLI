import { describe, expect, it } from "bun:test";
import {
	BackgroundAgentSupervisor,
	backgroundReportMessage,
} from "../src/core/agent/BackgroundAgentSupervisor.ts";
import { AgentCatalog } from "../src/core/agents/AgentCatalog.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { BUILT_IN_AGENTS } from "../src/core/agents/builtin.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { initialState } from "../src/state/AppState.ts";
import { reduce } from "../src/state/Store.ts";
import { AgentTool } from "../src/tools/AgentTool.tsx";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const BACKGROUND_AGENT: AgentDefinition = {
	name: "watcher",
	description: "Runs in the background.",
	mode: "worker",
	systemPrompt: "p",
	background: true,
	source: "project",
};

function ctx(agentDepth = 0): ToolContext {
	return {
		sessionId: "s",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
		agentDepth,
	};
}

function makeTool(options: {
	supervisor?: BackgroundAgentSupervisor;
	onRun?: (signal: AbortSignal) => Promise<void>;
}): { tool: AgentTool; depths: number[] } {
	const depths: number[] = [];
	const tool = new AgentTool({
		runner: {
			run: async ({ depth, parentSignal }) => {
				depths.push(depth);
				await options.onRun?.(parentSignal);
				return {
					report: "done",
					status: "completed" as const,
					usage: {},
					toolRounds: 2,
				};
			},
		},
		createRLMLoop: () => ({
			run: async () => {
				throw new Error("unused");
			},
		}),
		getCatalog: () => new AgentCatalog([BACKGROUND_AGENT, ...BUILT_IN_AGENTS]),
		maxDepth: 2,
		maxConcurrent: 4,
		...(options.supervisor ? { supervisor: options.supervisor } : {}),
	});
	return { tool, depths };
}

describe("BackgroundAgentSupervisor", () => {
	it("returns immediately and reports through the notifier", async () => {
		const bus = new EventBus();
		const supervisor = new BackgroundAgentSupervisor(bus);
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));

		const snapshot = supervisor.launch({
			definition: BACKGROUND_AGENT,
			prompt: "watch the build",
			run: async () => {
				await sleep(10);
				return {
					report: "build is green",
					status: "completed" as const,
					usage: {},
					toolRounds: 4,
				};
			},
		});

		expect(snapshot.status).toBe("running");
		expect(supervisor.active).toHaveLength(1);
		expect(reports).toHaveLength(0);

		await sleep(60);
		expect(supervisor.active).toHaveLength(0);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("build is green");
		expect(reports[0]).toContain('agent="watcher"');
	});

	it("does not link runs to the caller's signal", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const caller = new AbortController();
		let sawAbort: boolean | undefined;
		supervisor.launch({
			definition: BACKGROUND_AGENT,
			prompt: "keep going",
			run: async (signal) => {
				caller.abort();
				await sleep(10);
				sawAbort = signal.aborted;
				return {
					report: "r",
					status: "completed" as const,
					usage: {},
					toolRounds: 1,
				};
			},
		});
		await sleep(60);
		expect(sawAbort).toBe(false);
	});

	it("stays silent for runs it cancelled", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));
		supervisor.launch({
			definition: BACKGROUND_AGENT,
			prompt: "long job",
			run: async (signal) => {
				while (!signal.aborted) await sleep(5);
				return {
					report: "partial",
					status: "cancelled" as const,
					usage: {},
					toolRounds: 1,
				};
			},
		});

		await sleep(20);
		supervisor.cancelAll();
		await sleep(60);
		expect(reports).toEqual([]);
		expect(supervisor.active).toHaveLength(0);
	});

	it("still reports when the run throws", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));
		supervisor.launch({
			definition: BACKGROUND_AGENT,
			prompt: "explode",
			run: async () => {
				throw new Error("kaboom");
			},
		});
		await sleep(60);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("kaboom");
		expect(reports[0]).toContain('status="failed"');
	});

	it("warns the parent that the workspace may have moved on", () => {
		const message = backgroundReportMessage(
			{
				id: "bg_1",
				agent: "watcher",
				label: "l",
				status: "completed",
				startedAt: 0,
				finishedAt: 90_000,
				rounds: 3,
			},
			"findings",
		);
		expect(message).toContain('elapsed="90s"');
		expect(message).toContain("may have changed");
	});
});

describe("AgentTool background dispatch", () => {
	it("hands a background definition to the supervisor and returns at once", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const { tool } = makeTool({ supervisor });

		const result = await tool.execute(
			{ prompt: "watch", subagent_type: "watcher" },
			ctx(),
		);

		expect(result.data.status).toBe("launched");
		expect(result.data.runId).toBeDefined();
		expect(result.forLLM).toContain("do not wait for it");
		await sleep(40);
	});

	it("runs inline when no supervisor is wired", async () => {
		const { tool } = makeTool({});
		const result = await tool.execute(
			{ prompt: "watch", subagent_type: "watcher" },
			ctx(),
		);
		expect(result.data.status).toBe("completed");
	});

	it("ignores the background flag for nested spawns", async () => {
		const supervisor = new BackgroundAgentSupervisor(new EventBus());
		const { tool } = makeTool({ supervisor });

		// depth 1 in context => this spawn is depth 2, i.e. already nested.
		const result = await tool.execute(
			{ prompt: "watch", subagent_type: "watcher" },
			ctx(1),
		);
		expect(result.data.status).toBe("completed");
		expect(supervisor.active).toHaveLength(0);
	});
});

describe("background agents in AppState", () => {
	it("adds a row while running and drops it when finished", () => {
		const run = {
			id: "bg_1",
			agent: "watcher",
			label: "watch the build",
			status: "running" as const,
			startedAt: Date.now(),
			rounds: 0,
		};
		let state = initialState("gpt-test");
		state = reduce(state, {
			type: "agent:background_started",
			run,
		} satisfies AgentEvent);
		expect(state.backgroundAgents).toHaveLength(1);

		state = reduce(state, {
			type: "agent:background_finished",
			run: { ...run, status: "completed", rounds: 3, finishedAt: Date.now() },
		} satisfies AgentEvent);
		expect(state.backgroundAgents).toEqual([]);
	});
});
