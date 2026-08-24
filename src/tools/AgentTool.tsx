import { z } from "zod";
import type { AgentTraceStore } from "../core/agent/AgentTraceStore.ts";
import type { BackgroundAgentSupervisor } from "../core/agent/BackgroundAgentSupervisor.ts";
import type { JSONValue } from "../core/agent/rlm/RLMTypes.ts";
import type {
	DeadlineHandoff,
	SubAgentResult,
} from "../core/agent/SubAgentRunner.ts";
import type { AgentDefinition } from "../core/agents/AgentDefinition.ts";
import { WORKER_AGENT_NAME } from "../core/agents/builtin.ts";
import type { PermissionDecision } from "../core/permissions/types.ts";
import {
	type AgentMode,
	formatSpawnTree,
} from "../core/tools/AgentToolOutput.ts";
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
			"Optional wall-clock budget for this run. On expiry a worker moves to the background and keeps going; an rlm returns a partial-progress report.",
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

	override agentModeForInput(input: AgentToolInput): AgentMode | undefined {
		const requested =
			input && typeof input === "object" ? input.subagent_type : undefined;
		return this.deps
			.getCatalog()
			.get(typeof requested === "string" ? requested : WORKER_AGENT_NAME)?.mode;
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
			// Top-level only: a nested background spawn would outlive its owner.
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
				agent: run.definition.name,
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

	private async runRlm(run: AgentRun): Promise<ToolResult<AgentToolOutput>> {
		const { input, ctx, definition, trace, tracePath } = run;
		const result = await this.gated(run, () =>
			this.deps.createRLMLoop(definition).run({
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
				agent: definition.name,
				report: result.report,
				status: result.status,
				rounds: result.rounds,
				...(tracePath ? { tracePath } : {}),
			},
			result.report,
			agentTitle(result.status, result.rounds),
		);
	}

	/** Foreground calls pass the turn's signal; background calls the supervisor's. */
	private runWorkerAgainst(
		run: AgentRun,
		signal: AbortSignal,
	): Promise<SubAgentResult> {
		const { input, ctx, definition, depth, trace } = run;
		const traceContext = ctx.trace;
		const workerTrace =
			trace && traceContext
				? {
						sessionId: ctx.sessionId,
						context: traceContext,
						clientLogPath: trace.paths.clientLog,
					}
				: undefined;
		// A background run's tool row and checkpoint are already committed.
		const foreground = signal === ctx.signal;
		const onDeadline = this.deadlineHandoff(run, foreground);

		return this.deps.runner.run({
			prompt: input.prompt,
			definition,
			depth,
			parentCwd: ctx.cwd,
			parentSignal: signal,
			...(input.timeout_ms ? { timeoutMs: input.timeout_ms } : {}),
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
			// A run launched into the background, or already inside one, is the
			// background chain from its children's point of view.
			chainInBackground: !foreground,
			...(ctx.backgroundChain ? { parentChain: ctx.backgroundChain } : {}),
			...(onDeadline ? { onDeadline } : {}),
		});
	}

	/** Hands a slow run to the background instead of discarding its work. */
	private deadlineHandoff(
		run: AgentRun,
		foreground: boolean,
	): ((handoff: DeadlineHandoff) => { runId: string } | undefined) | undefined {
		const supervisor = this.deps.supervisor;
		// Only the top may hand off: a descendant would report past its owner.
		if (!supervisor || !foreground || run.depth !== 1) return undefined;
		return ({ continuation, cancel }) => ({
			runId: supervisor.adopt({
				definition: run.definition,
				prompt: run.input.prompt,
				continuation,
				cancel,
			}).id,
		});
	}

	/**
	 * Only top-level spawns take a permit. A permit holder must never wait on
	 * another permit: N parallel chains would each hold one and block forever on
	 * their descendants. Depth is capped, so the tree stays bounded regardless.
	 */
	private gated<T>(run: AgentRun, fn: () => Promise<T>): Promise<T> {
		if (run.depth > 1) return fn();
		return this.slots.run(fn, run.ctx.signal);
	}

	private async runWorker(run: AgentRun): Promise<ToolResult<AgentToolOutput>> {
		const { ctx, tracePath } = run;
		const result: SubAgentResult = await this.gated(run, () =>
			this.runWorkerAgainst(run, ctx.signal),
		);

		return ok(
			{
				mode: "worker",
				agent: run.definition.name,
				report: result.report,
				status: result.status,
				rounds: result.toolRounds,
				...(tracePath ? { tracePath } : {}),
				...(result.runId ? { runId: result.runId } : {}),
				...(result.logPath ? { logPath: result.logPath } : {}),
				...(result.children?.length ? { children: result.children } : {}),
			},
			workerReportForLLM(result),
			result.status === "backgrounded"
				? `Still running in background (${result.runId})`
				: agentTitle(result.status, result.toolRounds),
		);
	}
}

function agentTitle(status: string, rounds: number): string {
	const suffix = `${rounds} ${pluralize(rounds, "round")}`;
	if (status === "completed") return `Completed in ${suffix}`;
	if (status === "timed_out") return `Timed out after ${suffix}`;
	return `Failed after ${suffix}`;
}

function withSpawnTree(text: string, result: SubAgentResult): string {
	if (!result.children?.length) return text;
	return `${text}

Sub-agents it spawned:
${formatSpawnTree(result.children)}`;
}

function workerReportForLLM(result: SubAgentResult): string {
	return withSpawnTree(workerReportBody(result), result);
}

function workerReportBody(result: SubAgentResult): string {
	if (result.status === "completed") return result.report;
	// A handed-off run is still doing the work. Say so explicitly, or the model
	// reads a non-completed status as failure and starts the task over.
	if (result.status === "backgrounded") {
		const log = result.logPath
			? `\nIts transcript so far is at ${result.logPath} — read that to see where it is.`
			: "";
		return `The sub-agent exceeded its time budget but is STILL RUNNING in the background (id: ${result.runId}). It has not failed and its work is not lost.${log}

Do not start this task again. You will be given its report when it finishes. Continue with other work in the meantime, or tell the user it is still going.`;
	}
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
					"Optional wall-clock budget in milliseconds. On expiry a worker moves to the background and keeps going; an rlm returns partial progress.",
			},
		},
		required: ["prompt"],
		additionalProperties: false,
		$defs: {
			AgentJsonValue: jsonValueParameterSchema,
		},
	};
}
