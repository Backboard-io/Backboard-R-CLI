import { describe, expect, it } from "bun:test";
import { Config } from "../src/config/Config.ts";
import { AgentController } from "../src/core/agent/AgentController.ts";
import { BackgroundAgentSupervisor } from "../src/core/agent/BackgroundAgentSupervisor.ts";
import { AgentCatalog } from "../src/core/agents/AgentCatalog.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import { BUILT_IN_AGENTS } from "../src/core/agents/builtin.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { AgentEvent } from "../src/core/bus/events.ts";
import { emptyRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type { PermissionContext } from "../src/core/permissions/types.ts";
import { Session } from "../src/core/session/Session.ts";
import { SkillController } from "../src/core/skills/SkillController.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import type { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type {
	AssistantInfo,
	ProviderEvent,
	SendMessageRequest,
} from "../src/providers/backboard/types.ts";
import { initialState } from "../src/state/AppState.ts";
import { reduce } from "../src/state/Store.ts";
import { AgentTool } from "../src/tools/AgentTool.tsx";

const env = { apiKey: "k", apiUrl: "https://example.test/api" };
const PERMISSIONS: PermissionContext = {
	mode: "bypass",
	rules: emptyRuleSet(),
	interactive: false,
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const WATCHER: AgentDefinition = {
	name: "watcher",
	description: "Runs a long check in the background.",
	mode: "worker",
	systemPrompt: "You run checks.",
	background: true,
	source: "project",
};

/**
 * Answers the first user turn by calling Agent(watcher), then answers every
 * later turn (including the injected background report) with plain text.
 */
class ScriptedClient {
	readonly capabilities = { assistants: true, threads: true, memory: true };
	readonly prompts: string[] = [];
	private turn = 0;

	async listAssistants(): Promise<AssistantInfo[]> {
		return [];
	}
	async createAssistant(): Promise<AssistantInfo> {
		return { assistant_id: "asst_1", name: "test" };
	}
	sourceForThread(): "backboard" {
		return "backboard";
	}

	async *runMessage(req: SendMessageRequest): AsyncIterable<ProviderEvent> {
		this.prompts.push(req.content ?? "");
		this.turn++;
		yield { kind: "thread", threadId: "thr_1" };
		if (this.turn === 1) {
			yield {
				kind: "requires_action",
				runId: "run_1",
				calls: [
					{
						id: "call_1",
						name: "agent",
						input: { subagent_type: "watcher", prompt: "run the checks" },
					},
				],
			};
			return;
		}
		yield { kind: "assistant_delta", text: `ack turn ${this.turn}` };
		yield { kind: "completed" };
	}

	async *runToolOutputs(): AsyncIterable<ProviderEvent> {
		yield { kind: "assistant_delta", text: "launched, moving on" };
		yield { kind: "completed" };
	}
}

describe("background agent end-to-end", () => {
	it("returns the turn immediately, then delivers the report as its own turn", async () => {
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const events: AgentEvent[] = [];
		bus.onAny((event) => events.push(event));
		const session = new Session("sess_bg");
		const supervisor = new BackgroundAgentSupervisor(bus);

		let released!: () => void;
		const agentWork = new Promise<void>((resolve) => {
			released = resolve;
		});

		const agentTool = new AgentTool({
			runner: {
				run: async () => {
					await agentWork;
					return {
						report: "all 1414 checks passed",
						status: "completed" as const,
						usage: {},
						toolRounds: 3,
					};
				},
			},
			createRLMLoop: () => ({
				run: async () => {
					throw new Error("unused");
				},
			}),
			getCatalog: () => new AgentCatalog([WATCHER, ...BUILT_IN_AGENTS]),
			maxDepth: 2,
			maxConcurrent: 8,
			supervisor,
		});

		const client = new ScriptedClient();
		const controller = new AgentController({
			config,
			bus,
			session,
			registry: new ToolRegistry([agentTool]),
			client: client as unknown as BackboardClient,
			skillController: new SkillController({ cwd: config.cwd, bus }),
			permissions: PERMISSIONS,
			backgroundSupervisor: supervisor,
		});
		supervisor.setNotifier((report) => {
			void controller.submit(report, {
				emitUserMessage: false,
				priority: "later",
			});
		});

		// 1. The spawning turn finishes without waiting for the agent.
		const status = await controller.submit("run the checks in the background");
		expect(status).toBe("completed");
		expect(supervisor.active).toHaveLength(1);
		expect(client.prompts).toHaveLength(1);

		// 2. The UI shows it as running while the turn is already over.
		let state = initialState("test");
		for (const event of events) state = reduce(state, event);
		expect(state.backgroundAgents.map((run) => run.agent)).toEqual(["watcher"]);
		expect(state.status).not.toBe("running");

		// 3. When it finishes, its report drives a fresh turn on its own.
		released();
		await sleep(120);

		expect(supervisor.active).toHaveLength(0);
		expect(client.prompts).toHaveLength(2);
		expect(client.prompts[1]).toContain("all 1414 checks passed");
		expect(client.prompts[1]).toContain('agent="watcher"');
		expect(client.prompts[1]).toContain("may have changed");

		// 4. The status row clears once it reports.
		state = initialState("test");
		for (const event of events) state = reduce(state, event);
		expect(state.backgroundAgents).toEqual([]);
	});

	it("keeps background work alive when the foreground turn is cancelled", async () => {
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_bg2");
		const supervisor = new BackgroundAgentSupervisor(bus);

		let sawAbort: boolean | undefined;
		let released!: () => void;
		const agentWork = new Promise<void>((resolve) => {
			released = resolve;
		});

		const agentTool = new AgentTool({
			runner: {
				run: async ({ parentSignal }) => {
					await agentWork;
					sawAbort = parentSignal.aborted;
					return {
						report: "survived",
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
			getCatalog: () => new AgentCatalog([WATCHER, ...BUILT_IN_AGENTS]),
			maxDepth: 2,
			maxConcurrent: 8,
			supervisor,
		});

		const client = new ScriptedClient();
		const controller = new AgentController({
			config,
			bus,
			session,
			registry: new ToolRegistry([agentTool]),
			client: client as unknown as BackboardClient,
			skillController: new SkillController({ cwd: config.cwd, bus }),
			permissions: PERMISSIONS,
			backgroundSupervisor: supervisor,
		});
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));

		await controller.submit("start it");
		expect(supervisor.active).toHaveLength(1);

		// ESC on the main thread must not reach the background agent.
		controller.cancel();
		released();
		await sleep(120);

		expect(sawAbort).toBe(false);
		expect(reports).toHaveLength(1);
		expect(reports[0]).toContain("survived");
	});

	it("drops background reports when another session is resumed", async () => {
		const config = new Config({ env, argv: [] });
		const bus = new EventBus();
		const session = new Session("sess_bg3");
		const supervisor = new BackgroundAgentSupervisor(bus);

		let released!: () => void;
		const agentWork = new Promise<void>((resolve) => {
			released = resolve;
		});

		const agentTool = new AgentTool({
			runner: {
				run: async () => {
					await agentWork;
					return {
						report: "report for the discarded conversation",
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
			getCatalog: () => new AgentCatalog([WATCHER, ...BUILT_IN_AGENTS]),
			maxDepth: 2,
			maxConcurrent: 8,
			supervisor,
		});

		const client = new ScriptedClient();
		const controller = new AgentController({
			config,
			bus,
			session,
			registry: new ToolRegistry([agentTool]),
			client: client as unknown as BackboardClient,
			skillController: new SkillController({ cwd: config.cwd, bus }),
			permissions: PERMISSIONS,
			backgroundSupervisor: supervisor,
		});
		const reports: string[] = [];
		supervisor.setNotifier((report) => reports.push(report));

		await controller.submit("start it");
		expect(supervisor.active).toHaveLength(1);

		controller.hydrateSession({ threadId: "thr_other", messages: [] });
		released();
		await sleep(120);

		expect(supervisor.active).toHaveLength(0);
		expect(reports).toEqual([]);
	});
});
