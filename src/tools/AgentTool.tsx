import { z } from "zod";
import type { AgentTraceStore } from "../core/agent/AgentTraceStore.ts";
import type { BackgroundAgentSupervisor } from "../core/agent/BackgroundAgentSupervisor.ts";
import type { JSONValue } from "../core/agent/rlm/RLMTypes.ts";
import type { SubAgentResult } from "../core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../core/agents/AgentDefinition.ts";
import { WORKER_AGENT_NAME } from "../core/agents/builtin.ts";
import type { PermissionDecision } from "../core/permissions/types.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { Semaphore } from "../utils/semaphore.ts";
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
		.string()
		.optional()
		.describe(
			'Name of the agent to run. Defaults to "worker". Validated against the agent catalog at call time.',
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
		.positive()
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

/** One resolved spawn, shared by the worker and rlm execution paths. */
interface AgentRun {
	input: AgentToolInput;
	ctx: ToolContext;
	definition: AgentDefinition;
	depth: number;
	trace: AgentTraceStore | null;
	tracePath: string | undefined;
}

/**
 * Spawns an isolated sub-agent (a recursive worker). The parent receives only
 * the sub-agent's distilled report, never its intermediate tool churn, which
 * keeps long sessions free of context rot.
 */
export class AgentTool extends Tool<AgentToolInput, AgentToolOutput> {
	readonly name = "Agent";
	readonly inputSchema = schema;
	readonly readOnly = false;

	// Shared across depths: toolFactory hands children this same instance, so
	// nested spawns draw from one pool rather than one per level.
	private readonly slots: Semaphore;

	override get displayName(): string {
		return "Subagent";
	}

	constructor(private readonly deps: AgentToolDeps) {
		super();
		// A spawn chain holds one permit per level while each ancestor awaits its
		// descendant, so fewer permits than levels lets a chain deadlock against
		// itself. Fail at construction rather than at an unlucky nesting depth.
		if (deps.maxConcurrent < deps.maxDepth) {
			throw new Error(
				`AgentTool requires maxConcurrent (${deps.maxConcurrent}) >= maxDepth (${deps.maxDepth}) to avoid deadlocking nested spawns.`,
			);
		}
		this.slots = new Semaphore(deps.maxConcurrent);
	}

	override prompt(context: PromptContext = {}): string {
		const base = getToolPrompt(this.name, context);
		const catalog = this.deps.getCatalog().promptCatalog;
		return catalog ? `${base}\n\n### Available agents\n\n${catalog}` : base;
	}

	override toJSONSchema(context: PromptContext = {}): OpenAITool {
		return {
			type: "function",
			function: {
				name: this.agentName,
				description: this.prompt(context),
				parameters: agentToolParameters(this.deps.getCatalog().names),
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
		const catalog = this.deps.getCatalog();
		const requested = input.subagent_type ?? WORKER_AGENT_NAME;
		const definition = catalog.get(requested);
		if (!definition) {
			throw new Error(
				`Unknown subagent_type '${requested}'. Available agents: ${catalog.names.join(", ")}.`,
			);
		}

		const depth = (ctx.agentDepth ?? 0) + 1;
		const traceContext = ctx.trace;
		const trace =
			(await traceContext?.createAgentTrace({
				mode: definition.mode,
				prompt: input.prompt,
			})) ?? null;
		const tracePath = trace ? trace.relativePath(trace.paths.root) : undefined;

		if (depth > this.deps.maxDepth) {
			const report =
				"Agent recursion depth limit reached. Complete this work directly instead of spawning another sub-agent.";
			return ok(
				{
					mode: definition.mode,
					report,
					status: "rejected",
					rounds: 0,
					...(tracePath ? { tracePath } : {}),
				},
				report,
				"Rejected · depth limit reached",
			);
		}

		const run: AgentRun = { input, ctx, definition, depth, trace, tracePath };
		try {
			// Background dispatch is top-level only. A nested background spawn
			// would outlive the sub-agent that owns it, leaving no one to receive
			// its report, so deeper spawns run inline regardless of the flag.
			if (
				definition.background &&
				this.deps.supervisor &&
				definition.mode === "worker" &&
				depth === 1
			) {
				return this.launchBackground(run, this.deps.supervisor);
			}
			return definition.mode === "rlm"
				? await this.runRlm(run)
				: await this.runWorker(run);
		} catch (err) {
			await trace?.writeError(err);
			throw err;
		}
	}

	private launchBackground(
		run: AgentRun,
		supervisor: BackgroundAgentSupervisor,
	): ToolResult<AgentToolOutput> {
		const snapshot = supervisor.launch({
			definition: run.definition,
			prompt: run.input.prompt,
			run: (signal) => this.runWorkerAgainst(run, signal),
		});
		const report = `Launched background agent "${run.definition.name}" (${snapshot.id}). You will be given its report when it finishes. Continue with other work; do not wait for it, and do not duplicate what it is doing.`;
		return ok(
			{
				mode: "worker",
				report,
				status: "launched",
				rounds: 0,
				runId: snapshot.id,
				...(run.tracePath ? { tracePath: run.tracePath } : {}),
			},
			report,
			`Running in background (${snapshot.id})`,
		);
	}

	private async runRlm({
		input,
		ctx,
		definition,
		trace,
		tracePath,
	}: AgentRun): Promise<ToolResult<AgentToolOutput>> {
		const result = await this.slots.run(() =>
			this.deps.createRLMLoop().run({
				prompt: input.prompt,
				signal: ctx.signal,
				timeoutMs: input.timeout_ms ?? definition.timeoutMs,
				variables: input.variables,
			}),
		);
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
	}

	/**
	 * Runs the sub-agent under an explicit signal. Foreground calls pass the
	 * turn's signal; background calls pass the supervisor's, which is unlinked
	 * from the turn so cancelling the foreground leaves them running.
	 */
	private runWorkerAgainst(
		{ input, ctx, definition, depth, trace }: AgentRun,
		signal: AbortSignal,
	): Promise<SubAgentResult> {
		const traceContext = ctx.trace;
		const workerTrace =
			trace && traceContext
				? {
						sessionId: ctx.sessionId,
						context: traceContext,
						clientLogPath: trace.paths.clientLog,
					}
				: undefined;
		// A background run outlives the spawning turn, so its tool row is already
		// closed and its turn's checkpoint already finalized: relaying progress or
		// journaling edits there would mutate committed state. Both are dropped.
		const foreground = signal === ctx.signal;

		return this.deps.runner.run({
			prompt: input.prompt,
			definition,
			depth,
			parentCwd: ctx.cwd,
			parentSignal: signal,
			...(foreground
				? {
						parentBus: ctx.bus,
						parentToolCallId: ctx.toolCallId,
						parentTurnId: ctx.turnId,
						checkpoints: ctx.checkpoints,
					}
				: {}),
			parentPermissions: ctx.permissions,
			trace: workerTrace,
		});
	}

	private async runWorker(run: AgentRun): Promise<ToolResult<AgentToolOutput>> {
		const { ctx, tracePath } = run;
		const result: SubAgentResult = await this.slots.run(() =>
			this.runWorkerAgainst(run, ctx.signal),
		);

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
	const suffix = `${rounds} ${pluralize(rounds, "round")}`;
	if (status === "completed") return `Completed in ${suffix}`;
	if (status === "timed_out") return `Timed out after ${suffix}`;
	return `Failed after ${suffix}`;
}

function workerReportForLLM(result: SubAgentResult): string {
	if (result.status === "completed") return result.report;
	// A timed-out worker still summarized what it found, so hand the parent the
	// partial report rather than an error string it can only give up on.
	if (result.status === "timed_out") {
		return `Agent worker timed out after ${result.toolRounds} rounds. Partial progress:\n\n${result.report}`;
	}
	return `Error: Agent worker ${result.status} after ${result.toolRounds} rounds: ${result.report}`;
}

function agentToolParameters(agentNames: string[]): Record<string, unknown> {
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
				...(agentNames.length > 0 ? { enum: agentNames } : {}),
				description: `Agent to run. Defaults to "${WORKER_AGENT_NAME}".`,
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
