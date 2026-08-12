import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { HookController } from "../hooks/index.ts";
import { AbortError, isAbortError } from "./ToolAbort.ts";
import type { ToolContext } from "./ToolContext.ts";
import { toolErrorStartEvent, toolPendingEvent } from "./ToolEventFactory.ts";
import {
	type ErrorPlanEntry,
	type ExecutablePlanEntry,
	type PlanEntry,
	ToolExecutionPlanner,
} from "./ToolExecutionPlanner.ts";
import { ToolHookPipeline } from "./ToolHookPipeline.ts";
import { ToolInvocationRunner } from "./ToolInvocationRunner.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";

export { AbortError, isAbortError };

export interface ToolOutput {
	tool_call_id: string;
	output: string;
	metadata?: ToolOutputMetadata;
}

export interface ToolOutputMetadata {
	name: string;
	readOnly: boolean;
	error: boolean;
}

/**
 * Receives per-tool-call events while the provider response is still
 * streaming, so rendering and (safe) execution can start before the full
 * round arrives.
 */
export interface EarlyToolSink {
	/** The call's name has streamed; render its row immediately. */
	announce(id: string, name: string): void;
	/** The call's arguments finished streaming; it may start early. */
	offer(call: ToolCallRef): void;
	/** The stream is being retried; abort and discard all early state. */
	reset(): void;
}

export interface ToolCallRoundOptions {
	/** Calls for which this predicate returns true are ignored entirely
	 * (announce and offer are no-ops). Used to skip calls already answered
	 * in a previous round. */
	skip?: (id: string) => boolean;
}

type SettledOutput = { output: ToolOutput } | { error: unknown };

interface EarlyExecution {
	/** The parsed input the call actually ran with, for reconciliation
	 * against the authoritative list in finalize(). */
	input: unknown;
	settled: Promise<SettledOutput>;
	/** Aborts this execution alone - fired when finalize() discards it so the
	 * orphan can't race the authoritative re-run on the same transcript row. */
	abort: AbortController;
}

/**
 * Executes a turn's tool calls with correct ordering semantics:
 *   - consecutive concurrency-safe calls run together in parallel
 *   - any non-safe (write/destructive) call runs alone, in order
 * All outputs are collected and returned together so the caller can submit the
 * full set in one Backboard call. Cancellation throws AbortError; partial
 * outputs are discarded by the caller rather than submitted.
 *
 * createRound() returns a per-round object that additionally accepts streamed
 * per-call events (EarlyToolSink) so safe calls can start while the provider
 * response is still streaming.
 */
export class ToolScheduler {
	private readonly planner: ToolExecutionPlanner;
	private readonly invocationRunner: ToolInvocationRunner;

	constructor(
		private readonly registry: ToolRegistry,
		private readonly bus: EventBus,
		isToolEnabled: (name: string) => boolean = () => true,
		hookController?: HookController,
	) {
		this.planner = new ToolExecutionPlanner(
			registry,
			isToolEnabled,
			hookController,
		);
		this.invocationRunner = new ToolInvocationRunner(
			bus,
			new ToolHookPipeline(hookController),
		);
	}

	async run(calls: ToolCallRef[], ctx: ToolContext): Promise<ToolOutput[]> {
		return this.createRound(ctx).finalize(calls);
	}

	createRound(
		ctx: ToolContext,
		options: ToolCallRoundOptions = {},
	): ToolCallRound {
		return new ToolCallRound(
			this.planner,
			this.invocationRunner,
			this.registry,
			this.bus,
			ctx,
			options,
		);
	}
}

/**
 * One round of tool calls. Streamed events (announce/offer) may arrive before
 * the authoritative call list; finalize() reconciles against that list, awaits
 * early-started calls, runs the rest with the classic ordering semantics, and
 * returns outputs ordered by the final list.
 *
 * Early execution is deliberately conservative: a call starts before finalize
 * only when it is read-only AND concurrency-safe AND every call streamed
 * before it in this round has also streamed complete arguments. That preserves
 * the invariant that a read never runs ahead of an earlier write - writes
 * (including concurrency-safe-but-write-capable tools like Agent, and anything
 * unparseable) always wait for the full round.
 *
 * Rows announced to the UI are always resolved: execution events terminate the
 * rows finalize() runs, and reset()/finalize() emit `tool:retracted` for any
 * row abandoned by a stream retry or absent from the authoritative list.
 */
export class ToolCallRound implements EarlyToolSink {
	private readonly announced = new Set<string>();
	private readonly offered = new Set<string>();
	private readonly inFlight = new Map<string, EarlyExecution>();
	// Ids whose execution reached a terminal event (tool:result/tool:error).
	// Retraction skips them: a completed row must survive a mid-round abort,
	// and may already have drained to static scrollback where it can't be
	// un-printed anyway. The Store's tool:retracted reducer independently
	// refuses to drop terminal rows, which backstops the unavoidable microtask
	// gap between the runner's terminal emit and the add here.
	private readonly settledIds = new Set<string>();
	private completedOutputs: ToolOutput[] = [];
	// Bumped by every cleanup. An execution abandoned by reset() can be past
	// its last abort checkpoint and still settle afterwards; the epoch check
	// keeps its late settledIds.add from poisoning the next attempt, where the
	// same call id may be re-announced and must stay retractable.
	private epoch = 0;
	private earlyStartBlocked = false;

	constructor(
		private readonly planner: ToolExecutionPlanner,
		private readonly invocationRunner: ToolInvocationRunner,
		private readonly registry: ToolRegistry,
		private readonly bus: EventBus,
		private readonly ctx: ToolContext,
		private readonly options: ToolCallRoundOptions = {},
	) {}

	announce(id: string, name: string): void {
		if (this.options.skip?.(id) || this.announced.has(id)) return;
		this.announced.add(id);
		const tool = this.registry.get(name);
		this.bus.emit(
			toolPendingEvent(id, tool?.displayName ?? name, undefined, tool),
		);
	}

	offer(call: ToolCallRef): void {
		if (this.options.skip?.(call.id) || this.offered.has(call.id)) return;
		const entry = this.planner.build([call])[0];
		if (!entry) return;
		this.offered.add(call.id);
		// Re-emitting pending is safe: the store upserts by id, filling in the
		// input summary on a row announced with the name alone.
		this.emitPending(entry);
		this.announced.add(call.id);

		const startable =
			entry.concurrencySafe && !this.earlyStartBlocked && this.allOffered();
		if (!entry.concurrencySafe) this.earlyStartBlocked = true;
		if (!startable || "errorOutput" in entry) return;
		// Concurrency-safe is not enough on its own: Agent is concurrency-safe
		// but write-capable, and an early-started write abandoned by a stream
		// retry would keep mutating files. Only reads may run ahead.
		// (Hooked tools can't reach here either: the planner clears
		// concurrencySafe for any tool with a matching trusted hook, so
		// user hooks keep exactly-once semantics - a discarded early run
		// would otherwise fire them twice for one call id. Untrusted hooks
		// never execute at all.)
		if (!entry.tool.isReadOnly(entry.input)) return;
		const abort = new AbortController();
		const earlyCtx: ToolContext = {
			...this.ctx,
			signal: AbortSignal.any([this.ctx.signal, abort.signal]),
		};
		this.inFlight.set(call.id, {
			input: entry.input,
			abort,
			settled: this.runTracked(entry, earlyCtx).then(
				(output): SettledOutput => {
					// Post-settlement abort is inert for the run itself; it just
					// detaches the composite signal from the turn-long ctx.signal
					// so consumed executions don't accumulate listeners there.
					abort.abort();
					return { output };
				},
				(error): SettledOutput => {
					abort.abort();
					return { error };
				},
			),
		});
	}

	reset(): void {
		// Abort in-flight early executions instead of merely forgetting them:
		// a retried stream can re-offer the same call id, and an un-aborted
		// orphan would execute concurrently with the retry's run while its
		// events keep mutating the transcript row.
		this.cleanup();
		this.completedOutputs = [];
		this.earlyStartBlocked = false;
	}

	completedToolOutputs(): readonly ToolOutput[] {
		return this.completedOutputs;
	}

	async finalize(calls: ToolCallRef[]): Promise<ToolOutput[]> {
		const ctx = this.ctx;
		const plan = this.planner.build(calls);
		// Announce every call in the round up front so the UI can show the
		// whole batch immediately - without this, a call queued behind a
		// slow batch stays invisible until the scheduler reaches it.
		// Track them in announced too: if finalize aborts mid-round, the
		// finally-reset can only retract rows it knows about.
		for (const entry of plan) {
			if (!this.announced.has(entry.ref.id)) this.emitPending(entry);
			this.announced.add(entry.ref.id);
		}
		const outputs: ToolOutput[] = [];
		this.completedOutputs = outputs;
		let batch: Array<() => Promise<ToolOutput>> = [];

		const flushBatch = async (): Promise<void> => {
			if (batch.length === 0) return;
			const results = await Promise.allSettled(batch.map((start) => start()));
			for (const result of results) {
				if (result.status === "fulfilled") outputs.push(result.value);
			}
			batch = [];
			const failure = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		};

		for (const entry of plan) {
			if (ctx.signal.aborted) throw new AbortError();

			const early = this.takeMatchingEarlyExecution(entry);
			if (early) {
				batch.push(() => unwrapSettled(early.settled));
				continue;
			}

			if (entry.concurrencySafe) {
				batch.push(() => this.runTracked(entry, ctx));
				continue;
			}

			await flushBatch();
			if ("errorOutput" in entry) {
				outputs.push(this.errorOutput(entry));
			} else {
				outputs.push(await this.runTracked(entry, ctx));
			}
		}

		await flushBatch();
		// Retract any streamed row the authoritative list never confirmed so
		// the UI can drop it; its settled promise can never reject unhandled.
		this.cleanup(new Set(plan.map((entry) => entry.ref.id)));
		return outputs;
	}

	/**
	 * Shared tail of reset() and finalize(): abort early executions that are
	 * still in flight (an un-aborted orphan would keep running - and keep
	 * emitting events - after its row is gone), retract unresolved announced
	 * rows, and drop per-attempt state.
	 */
	private cleanup(confirmed?: Set<string>): void {
		for (const early of this.inFlight.values()) early.abort.abort();
		this.retractAnnounced(confirmed);
		this.inFlight.clear();
		this.settledIds.clear();
		this.epoch++;
	}

	/** Run an entry and remember that its row reached a terminal event, so a
	 * later retraction can't delete a completed row. The runner only rejects
	 * on abort, which emits no terminal event - those stay retractable. The
	 * epoch check discards a settle that lands after cleanup() already moved
	 * this round to its next attempt. */
	private runTracked(
		entry: ExecutablePlanEntry,
		ctx: ToolContext,
	): Promise<ToolOutput> {
		const epoch = this.epoch;
		return this.invocationRunner.run(entry, ctx).then((output) => {
			if (epoch === this.epoch) this.settledIds.add(entry.ref.id);
			return output;
		});
	}

	/**
	 * Reuse the early result only when the input it actually ran with matches
	 * the authoritative input. They can diverge for the same id: the server's
	 * continuation path overwrites the args accumulator wholesale after the
	 * ready event is emitted. On mismatch the entry re-runs normally.
	 */
	private takeMatchingEarlyExecution(
		entry: PlanEntry,
	): EarlyExecution | undefined {
		const early = this.inFlight.get(entry.ref.id);
		if (!early) return undefined;
		this.inFlight.delete(entry.ref.id);
		// Discarded executions are aborted, not just forgotten: an orphan left
		// running would race the authoritative re-run of the same id, and
		// whichever settles last would own the visible row.
		if (
			"errorOutput" in entry ||
			JSON.stringify(early.input) !== JSON.stringify(entry.input)
		) {
			early.abort.abort();
			return undefined;
		}
		return early;
	}

	/** Emit tool:retracted for every announced row that was neither confirmed
	 * by the authoritative list nor already resolved by a terminal event. */
	private retractAnnounced(confirmed?: Set<string>): void {
		for (const id of this.announced) {
			if (confirmed?.has(id) || this.settledIds.has(id)) continue;
			this.bus.emit({ type: "tool:retracted", toolCallId: id });
		}
		this.announced.clear();
		this.offered.clear();
	}

	private allOffered(): boolean {
		// offer() adds to both sets, so offered ⊆ announced always holds.
		return this.offered.size === this.announced.size;
	}

	private emitPending(entry: PlanEntry): void {
		// For error entries the tool instance isn't on the entry, so resolve it
		// from the registry: a disabled/invalid-args row still summarizes its own
		// input (e.g. the file path), while a genuinely unknown tool falls back.
		const tool =
			"errorOutput" in entry ? this.registry.get(entry.ref.name) : entry.tool;
		this.bus.emit(
			toolPendingEvent(
				entry.ref.id,
				("errorOutput" in entry ? entry.displayName : entry.tool.displayName) ??
					entry.ref.name,
				"errorOutput" in entry ? entry.ref.input : entry.input,
				tool,
			),
		);
	}

	private errorOutput(entry: ErrorPlanEntry): ToolOutput {
		this.settledIds.add(entry.ref.id);
		this.bus.emit(
			toolErrorStartEvent(
				entry.ref,
				entry.displayName,
				this.registry.get(entry.ref.name),
			),
		);
		this.bus.emit({
			type: "tool:error",
			toolCallId: entry.ref.id,
			name: entry.displayName ?? entry.ref.name,
			error: entry.errorOutput,
		});
		return {
			tool_call_id: entry.ref.id,
			output: entry.errorOutput,
			metadata: { name: entry.ref.name, readOnly: false, error: true },
		};
	}
}

async function unwrapSettled(
	settled: Promise<SettledOutput>,
): Promise<ToolOutput> {
	const result = await settled;
	if ("output" in result) return result.output;
	throw result.error;
}
