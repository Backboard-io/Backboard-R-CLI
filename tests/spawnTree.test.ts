import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { SubAgentRunner } from "../src/core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import {
	type AgentToolOutput,
	formatSpawnTree,
} from "../src/core/tools/AgentToolOutput.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type { ProviderEvent } from "../src/providers/backboard/types.ts";
import { TEST_BACKBOARD_ENV, TEST_MODEL } from "./helpers/agent.ts";

const DEF: AgentDefinition = {
	name: "builder",
	description: "d",
	mode: "worker",
	systemPrompt: "p",
	source: "project",
};

/** One tool round calling the Agent tool, then a final answer. */
class SpawningClient extends BackboardClient {
	constructor() {
		super(TEST_BACKBOARD_ENV);
	}
	override async *runMessage(): AsyncIterable<ProviderEvent> {
		yield { kind: "thread", threadId: "t" };
		yield {
			kind: "requires_action",
			runId: "r",
			calls: [{ id: "c1", name: "agent", input: { prompt: "dig" } }],
		};
	}
	override async *runToolOutputs(): AsyncIterable<ProviderEvent> {
		yield { kind: "assistant_delta", text: "built it" };
		yield { kind: "completed" };
	}
	override async listAssistants() {
		return [];
	}
	override async createAssistant() {
		return { assistant_id: "a", name: "t" };
	}
}

/** Stands in for a nested Agent tool, reporting its own spawn tree. */
class FakeAgentTool extends Tool<{ prompt?: string }, AgentToolOutput> {
	readonly name = "Agent";
	readonly inputSchema = z.object({ prompt: z.string().optional() });

	override isReadOnly(): boolean {
		return false;
	}

	// The real Agent tool auto-allows; its children are gated individually.
	override checkPermissions() {
		return { behavior: "allow" as const, reason: "test" };
	}

	override async execute(): Promise<ToolResult<AgentToolOutput>> {
		return ok(
			{
				mode: "worker",
				agent: "researcher",
				report: "found it",
				status: "completed",
				rounds: 4,
				children: [{ agent: "scribe", status: "completed", rounds: 2 }],
			},
			"found it",
			"Completed in 4 rounds",
		);
	}
}

describe("spawn tree", () => {
	it("reports the sub-agents a sub-agent created, and theirs", async () => {
		const runner = new SubAgentRunner({
			client: new SpawningClient(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [new FakeAgentTool()],
		});

		const result = await runner.run({
			prompt: "build it",
			definition: DEF,
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});

		expect(result.report).toBe("built it");
		expect(result.children).toEqual([
			{
				agent: "researcher",
				status: "completed",
				rounds: 4,
				children: [{ agent: "scribe", status: "completed", rounds: 2 }],
			},
		]);
	});

	it("omits the field when a sub-agent spawned nothing", async () => {
		class Plain extends SpawningClient {
			override async *runMessage(): AsyncIterable<ProviderEvent> {
				yield { kind: "thread", threadId: "t" };
				yield { kind: "assistant_delta", text: "done alone" };
				yield { kind: "completed" };
			}
		}
		const runner = new SubAgentRunner({
			client: new Plain(),
			getModel: () => TEST_MODEL,
			memory: "off",
			memoryProfile: "code",
			getThinking: async () => undefined,
			toolFactory: () => [],
		});
		const result = await runner.run({
			prompt: "x",
			definition: DEF,
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: new AbortController().signal,
		});
		expect(result.children).toBeUndefined();
	});
});

describe("formatSpawnTree", () => {
	it("nests descendants and flags work still running", () => {
		expect(
			formatSpawnTree([
				{ agent: "researcher", status: "completed", rounds: 4 },
				{
					agent: "watcher",
					status: "backgrounded",
					rounds: 3,
					runId: "bg_9a12",
					children: [{ agent: "scribe", status: "completed", rounds: 1 }],
				},
			]),
		).toBe(
			[
				"  - researcher — completed, 4 rounds",
				"  - watcher — still running in background (bg_9a12)",
				"    - scribe — completed, 1 round",
			].join("\n"),
		);
	});
});
