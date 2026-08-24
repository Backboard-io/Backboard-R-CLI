import { z } from "zod";
import type { JSONValue } from "../core/agent/rlm/RLMTypes.ts";
import type { SubAgentResult } from "../core/agent/SubAgentRunner.ts";
import type { PermissionDecision } from "../core/permissions/types.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { pluralize } from "../utils/string.ts";
import type {
	AgentToolDeps,
	AgentToolInput,
	AgentToolOutput,
} from "./AgentToolTypes.ts";

const jsonValueSchema = z.custom<JSONValue>((value) => {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key: string, nested: unknown): unknown => {
				if (
					nested === undefined ||
					typeof nested === "function" ||
					typeof nested === "symbol" ||
					typeof nested === "bigint"
				) {
					throw new TypeError("not json");
				}
				if (typeof nested === "number" && !Number.isFinite(nested)) {
					throw new TypeError("not json");
				}
				if (nested !== null && typeof nested === "object") {
					if (seen.has(nested)) throw new TypeError("cyclic json");
					seen.add(nested);
				}
				return nested;
			}) !== undefined
		);
	} catch {
		return false;
	}
}, "variables must contain only JSON-serializable values");

const schema = z.object({
	subagent_type: z
		.enum(["worker", "rlm"])
		.optional()
		.describe(
			'"worker" (default) runs a tool-using sub-agent over the project; "rlm" analyzes the prompt and provided variables in a JavaScript REPL.',
		),
	prompt: z
		.string()
		.min(1)
		.describe(
			"The full delegated prompt, including all task detail, context, and report requirements.",
		),
	variables: z
		.record(jsonValueSchema)
		.optional()
		.describe(
			"Optional JSON object for rlm sub-agents. Values are available as inputs; valid non-reserved keys are also direct variables.",
		),
	timeout_ms: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe(
			"Optional wall-clock budget for rlm sub-agents. When the budget expires, the RLM returns a partial-progress report instead of continuing normal code execution.",
		),
});

export type {
	AgentToolDeps,
	AgentToolInput,
	AgentToolOutput,
} from "./AgentToolTypes.ts";

/**
 * Spawns an isolated sub-agent (a recursive worker). The parent receives only
 * the sub-agent's distilled report, never its intermediate tool churn, which
 * keeps long sessions free of context rot.
 */
export class AgentTool extends Tool<AgentToolInput, AgentToolOutput> {
	readonly name = "Agent";
	readonly inputSchema = schema;
	readonly readOnly = false;

	override get displayName(): string {
		return "Subagent";
	}

	constructor(private readonly deps: AgentToolDeps) {
		super();
	}

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override toJSONSchema(context: PromptContext = {}): OpenAITool {
		return {
			type: "function",
			function: {
				name: this.agentName,
				description: this.prompt(context),
				parameters: agentToolParameters(),
			},
		};
	}

	override isReadOnly(_input: AgentToolInput): boolean {
		return this.readOnly;
	}

	override isConcurrencySafe(_input: AgentToolInput): boolean {
		return true;
	}

	// Spawning is orchestration, not a direct effect: the sub-agent inherits the
	// permission context and its own tool calls are gated individually, so the
	// spawn itself auto-allows (else a non-interactive sub-agent can't delegate).
	override checkPermissions(): PermissionDecision | undefined {
		return {
			behavior: "allow",
			reason: "sub-agent tools are gated individually",
		};
	}

	override async execute(
		input: AgentToolInput,
		ctx: ToolContext,
	): Promise<ToolResult<AgentToolOutput>> {
		const subagentType = input.subagent_type ?? "worker";
		const depth = (ctx.agentDepth ?? 0) + 1;
		const traceContext = ctx.trace;
		const trace =
			(await traceContext?.createAgentTrace({
				mode: subagentType,
				prompt: input.prompt,
			})) ?? null;
		const tracePath = trace ? trace.relativePath(trace.paths.root) : undefined;

		if (depth > this.deps.maxDepth) {
			const report =
				"Agent recursion depth limit reached. Complete this work directly instead of spawning another sub-agent.";
			return ok(
				{
					mode: subagentType,
					report,
					status: "rejected",
					rounds: 0,
					...(tracePath ? { tracePath } : {}),
				},
				report,
				"Rejected · depth limit reached",
			);
		}

		if (subagentType === "rlm") {
			try {
				const result = await this.deps.createRLMLoop().run({
					prompt: input.prompt,
					signal: ctx.signal,
					timeoutMs: input.timeout_ms,
					variables: input.variables,
				});
				await trace?.writeRLMResult(result);
				return ok(
					{
						mode: "rlm",
						report: result.report,
						status: result.status,
						rounds: result.rounds,
						...(tracePath ? { tracePath } : {}),
					},
					result.report,
					agentTitle(result.status, result.rounds),
				);
			} catch (err) {
				await trace?.writeError(err);
				throw err;
			}
		}

		let result: SubAgentResult;
		const workerTrace =
			trace && traceContext
				? {
						sessionId: ctx.sessionId,
						context: traceContext,
						clientLogPath: trace.paths.clientLog,
					}
				: undefined;
		try {
			result = await this.deps.runner.run({
				prompt: input.prompt,
				depth,
				parentCwd: ctx.cwd,
				parentSignal: ctx.signal,
				parentBus: ctx.bus,
				parentToolCallId: ctx.toolCallId,
				parentTurnId: ctx.turnId,
				checkpoints: ctx.checkpoints,
				parentPermissions: ctx.permissions,
				trace: workerTrace,
			});
		} catch (err) {
			await trace?.writeError(err);
			throw err;
		}
		return ok(
			{
				mode: "worker",
				report: result.report,
				status: result.status,
				rounds: result.toolRounds,
				...(tracePath ? { tracePath } : {}),
			},
			workerReportForLLM(result),
			agentTitle(result.status, result.toolRounds),
		);
	}
}

function agentTitle(status: string, rounds: number): string {
	return status === "completed"
		? `Completed in ${rounds} ${pluralize(rounds, "round")}`
		: `Failed after ${rounds} ${pluralize(rounds, "round")}`;
}

function workerReportForLLM(result: SubAgentResult): string {
	if (result.status === "completed") return result.report;
	return `Error: Agent worker ${result.status} after ${result.toolRounds} rounds: ${result.report}`;
}

function agentToolParameters(): Record<string, unknown> {
	const jsonValueParameterSchema = {
		anyOf: [
			{ type: "string" },
			{ type: "number" },
			{ type: "boolean" },
			{ type: "null" },
			{ type: "array", items: { $ref: "#/$defs/AgentJsonValue" } },
			{
				type: "object",
				additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
			},
		],
	};

	return {
		type: "object",
		properties: {
			subagent_type: {
				type: "string",
				enum: ["worker", "rlm"],
				description: '"worker" (default) or "rlm".',
			},
			prompt: {
				type: "string",
				minLength: 1,
				description: "The full prompt for the sub-agent.",
			},
			variables: {
				type: "object",
				description: "Optional JSON input variables for RLM sub-agents.",
				additionalProperties: { $ref: "#/$defs/AgentJsonValue" },
			},
			timeout_ms: {
				type: "integer",
				minimum: 1,
				description:
					"Optional wall-clock budget in milliseconds for RLM sub-agents.",
			},
		},
		required: ["prompt"],
		additionalProperties: false,
		$defs: {
			AgentJsonValue: jsonValueParameterSchema,
		},
	};
}
