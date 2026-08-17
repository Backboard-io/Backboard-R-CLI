import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTraceContext } from "../src/core/agent/AgentTraceStore.ts";
import type { RLMRunParams } from "../src/core/agent/rlm/RLMLoop.ts";
import type {
	SubAgentResult,
	SubAgentRunParams,
} from "../src/core/agent/SubAgentRunner.ts";
import { AgentCatalog } from "../src/core/agents/AgentCatalog.ts";
import { BUILT_IN_AGENTS } from "../src/core/agents/builtin.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { AgentTool, type AgentToolDeps } from "../src/tools/AgentTool.tsx";

function ctx(
	agentDepth: number,
	overrides: Partial<ToolContext> = {},
): ToolContext {
	return {
		sessionId: "s",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
		agentDepth,
		...overrides,
	};
}

function makeTool(
	options: {
		workerResult?: Partial<SubAgentResult>;
	} & Partial<AgentToolDeps> = {},
): {
	tool: AgentTool;
	workerCalls: SubAgentRunParams[];
	rlmCalls: RLMRunParams[];
} {
	const { workerResult, ...overrides } = options;
	const workerCalls: SubAgentRunParams[] = [];
	const rlmCalls: RLMRunParams[] = [];
	const runner: AgentToolDeps["runner"] = {
		run: async (params: SubAgentRunParams) => {
			workerCalls.push(params);
			return {
				report: "worker report",
				status: "completed" as const,
				usage: {},
				toolRounds: 3,
				...workerResult,
			};
		},
	};
	const rlmLoop: ReturnType<AgentToolDeps["createRLMLoop"]> = {
		run: async (params: RLMRunParams) => {
			rlmCalls.push(params);
			return {
				report: "rlm report",
				status: "completed" as const,
				usage: {},
				rounds: 4,
				trajectory: [],
			};
		},
	};

	const tool = new AgentTool({
		runner,
		createRLMLoop: () => rlmLoop,
		getCatalog: () => new AgentCatalog(BUILT_IN_AGENTS),
		maxDepth: 2,
		maxConcurrent: 8,
		...overrides,
	});
	return { tool, workerCalls, rlmCalls };
}

describe("AgentTool schema and flags", () => {
	it("requires prompt and defaults subagent_type to worker behavior", () => {
		const { tool } = makeTool();
		expect(() => tool.parseInput({})).toThrow();
		const parsed = tool.parseInput({ prompt: "do it" });
		expect(parsed.prompt).toBe("do it");
		expect(parsed.subagent_type).toBeUndefined();
	});

	it("rejects subagent types absent from the catalog", async () => {
		const { tool } = makeTool();
		await expect(
			tool.execute({ prompt: "do it", subagent_type: "planner" }, ctx(0)),
		).rejects.toThrow("Unknown subagent_type 'planner'");
	});

	it("advertises catalog agents in the schema enum and description", () => {
		const { tool } = makeTool({
			getCatalog: () =>
				new AgentCatalog([
					...BUILT_IN_AGENTS,
					{
						name: "researcher",
						description: "Deep-dives one question.",
						mode: "worker",
						systemPrompt: "You research.",
						source: "project",
					},
				]),
		});
		const parameters = tool.toJSONSchema().function.parameters as {
			properties?: { subagent_type?: { enum?: string[] } };
		};
		expect(parameters.properties?.subagent_type?.enum).toEqual([
			"worker",
			"rlm",
			"researcher",
		]);
		expect(tool.prompt()).toContain("`researcher`: Deep-dives one question.");
	});

	it("emits a Backboard-compatible variables object schema", () => {
		const { tool } = makeTool();
		type AgentParameters = OpenAITool["function"]["parameters"] & {
			properties?: {
				variables?: {
					type?: string;
					description?: string;
					additionalProperties?: {
						$ref?: string;
					};
				};
			};
			$defs?: {
				AgentJsonValue?: {
					anyOf?: Array<{ type?: string }>;
				};
			};
		};
		const parameters: AgentParameters = tool.toJSONSchema().function.parameters;
		expect(parameters.properties?.variables).toMatchObject({
			type: "object",
			description: "Optional JSON input variables for RLM sub-agents.",
			additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
		});
		expect(
			parameters.$defs?.AgentJsonValue?.anyOf?.map((item) => item.type),
		).toEqual(["string", "number", "boolean", "null", "array", "object"]);
	});

	it("exports the variables schema without recursive conversion warnings", () => {
		const { tool } = makeTool();
		const warn = console.warn;
		const warnings: string[] = [];
		console.warn = (...args) => {
			warnings.push(args.map(String).join(" "));
		};
		try {
			tool.toJSONSchema();
		} finally {
			console.warn = warn;
		}

		expect(warnings).toEqual([]);
	});

	it("rejects non-json variable values", () => {
		const { tool } = makeTool();
		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { value: BigInt(1) },
			}),
		).toThrow("variables must contain only JSON-serializable values");
		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { invalid: () => "no" },
			}),
		).toThrow("variables must contain only JSON-serializable values");
	});

	it("rejects cyclic variable values", () => {
		const { tool } = makeTool();
		type Cyclic = { self?: Cyclic };
		const cyclic: Cyclic = {};
		cyclic.self = cyclic;

		expect(() =>
			tool.parseInput({
				prompt: "inspect",
				variables: { cyclic },
			}),
		).toThrow("variables must contain only JSON-serializable values");
	});

	it("is never read-only but is concurrency-safe", () => {
		const { tool } = makeTool();
		expect(tool.isReadOnly({ prompt: "t" })).toBe(false);
		expect(tool.isConcurrencySafe({ prompt: "t" })).toBe(true);
		expect(tool.isReadOnly({ prompt: "t", subagent_type: "rlm" })).toBe(false);
		expect(tool.isConcurrencySafe({ prompt: "t", subagent_type: "rlm" })).toBe(
			true,
		);
	});
});

describe("AgentTool execution", () => {
	it("runs the worker by default and passes the full prompt with depth+1", async () => {
		const { tool, workerCalls } = makeTool();
		const result = await tool.execute({ prompt: "investigate" }, ctx(0));
		expect(result.forLLM).toBe("worker report");
		expect(result.data.mode).toBe("worker");
		expect(workerCalls).toHaveLength(1);
		expect(workerCalls[0]?.prompt).toBe("investigate");
		expect(workerCalls[0]?.depth).toBe(1);
	});

	it("runs the worker for explicit worker subagent_type", async () => {
		const { tool, workerCalls } = makeTool();
		await tool.execute({ prompt: "inspect", subagent_type: "worker" }, ctx(0));
		expect(workerCalls[0]?.prompt).toBe("inspect");
	});

	it("surfaces worker failures in the LLM-facing output", async () => {
		const { tool } = makeTool({
			workerResult: {
				report: "(the sub-agent produced no output)",
				status: "failed",
				toolRounds: 20,
			},
		});
		const result = await tool.execute({ prompt: "inspect" }, ctx(0));

		expect(result.data.status).toBe("failed");
		expect(result.forLLM).toBe(
			"Error: Agent worker failed after 20 rounds: (the sub-agent produced no output)",
		);
	});

	it("runs the rlm loop with prompt as the full context", async () => {
		const { tool, rlmCalls } = makeTool();
		const result = await tool.execute(
			{
				prompt: "big text",
				subagent_type: "rlm",
				timeout_ms: 300_000,
				variables: { files: [{ path: "a.ts", text: "export {}" }] },
			},
			ctx(0),
		);
		expect(result.forLLM).toBe("rlm report");
		expect(result.data.mode).toBe("rlm");
		expect(rlmCalls[0]?.prompt).toBe("big text");
		expect(rlmCalls[0]?.timeoutMs).toBe(300_000);
		expect(rlmCalls[0]?.variables).toEqual({
			files: [{ path: "a.ts", text: "export {}" }],
		});
	});

	it("writes an RLM trace when a trace context is available", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-agent-trace-"));
		try {
			const sessionRoot = join(dir, ".backboard", "sessions", "sess_trace");
			const { tool } = makeTool();
			const result = await tool.execute(
				{ prompt: "trace me", subagent_type: "rlm" },
				ctx(0, {
					cwd: dir,
					trace: new AgentTraceContext({
						sessionId: "s",
						sessionRoot,
						cwd: dir,
					}).forToolCall("call_trace"),
				}),
			);

			expect(result.data.tracePath).toBe(
				".backboard/sessions/sess_trace/agents/call_trace",
			);
			const trace = JSON.parse(
				await readFile(
					join(sessionRoot, "agents", "call_trace", "trajectory.json"),
					"utf8",
				),
			);
			expect(trace.report).toBe("rlm report");
			expect(trace.status).toBe("completed");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("writes an Agent error trace when RLM execution throws", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cli-agent-error-trace-"));
		try {
			const sessionRoot = join(dir, ".backboard", "sessions", "sess_trace");
			const { tool } = makeTool({
				createRLMLoop: () => ({
					run: async () => {
						throw new Error("rlm exploded");
					},
				}),
			});

			await expect(
				tool.execute(
					{ prompt: "trace me", subagent_type: "rlm" },
					ctx(0, {
						cwd: dir,
						trace: new AgentTraceContext({
							sessionId: "s",
							sessionRoot,
							cwd: dir,
						}).forToolCall("call_trace"),
					}),
				),
			).rejects.toThrow("rlm exploded");

			const error = JSON.parse(
				await readFile(
					join(sessionRoot, "agents", "call_trace", "error.json"),
					"utf8",
				),
			);
			expect(error.message).toBe("rlm exploded");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects recursive Agent calls past the depth cap", async () => {
		const { tool, workerCalls } = makeTool();
		const result = await tool.execute({ prompt: "deep" }, ctx(100));
		expect(result.data.status).toBe("rejected");
		expect(workerCalls).toHaveLength(0);
	});
});
