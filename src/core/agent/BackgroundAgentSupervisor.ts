import { errorMessage } from "../../utils/errors.ts";
import { shortId } from "../../utils/id.ts";
import { Semaphore } from "../../utils/semaphore.ts";
import { truncate } from "../../utils/string.ts";
import type { AgentDefinition } from "../agents/AgentDefinition.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { BackgroundRunSnapshot } from "../bus/events.ts";
import type { SubAgentResult } from "./SubAgentTypes.ts";

export const DEFAULT_BACKGROUND_MAX_CONCURRENT = 4;
const LABEL_LENGTH = 60;

export interface BackgroundLaunchParams {
	definition: AgentDefinition;
	prompt: string;
	/** Runs the sub-agent against the supervisor's own signal. */
	run: (signal: AbortSignal) => Promise<SubAgentResult>;
}

interface BackgroundRun {
	snapshot: BackgroundRunSnapshot;
	abort: AbortController;
}

/**
 * Owns sub-agents that outlive the turn that spawned them.
 *
 * Each run gets an AbortController deliberately unlinked from the parent turn,
 * so cancelling the foreground does not kill background work; `cancelAll` is
 * the explicit way to stop them. Completion is delivered back through the
 * notifier as a low-priority submission, which is why the supervisor never
 * touches the AgentController directly.
 */
export class BackgroundAgentSupervisor {
	private readonly runs = new Map<string, BackgroundRun>();
	private readonly slots: Semaphore;
	private notifier: ((report: string) => void) | undefined;

	constructor(
		private readonly bus: EventBus,
		maxConcurrent: number = DEFAULT_BACKGROUND_MAX_CONCURRENT,
	) {
		this.slots = new Semaphore(maxConcurrent);
	}

	/** Wired after construction: the controller needs the tools that need this. */
	setNotifier(notifier: (report: string) => void): void {
		this.notifier = notifier;
	}

	get active(): BackgroundRunSnapshot[] {
		return [...this.runs.values()]
			.map((run) => run.snapshot)
			.filter((snapshot) => snapshot.status === "running");
	}

	launch(params: BackgroundLaunchParams): BackgroundRunSnapshot {
		const id = shortId("bg");
		const abort = new AbortController();
		const snapshot: BackgroundRunSnapshot = {
			id,
			agent: params.definition.name,
			label: truncate(params.prompt.replace(/\s+/gu, " ").trim(), LABEL_LENGTH),
			status: "running",
			startedAt: Date.now(),
			rounds: 0,
		};
		this.runs.set(id, { snapshot, abort });
		this.bus.emit({ type: "agent:background_started", run: snapshot });

		void this.drive(id, params, abort.signal);
		return snapshot;
	}

	cancelAll(): void {
		for (const run of this.runs.values()) {
			if (run.snapshot.status === "running") run.abort.abort();
		}
	}

	private async drive(
		id: string,
		params: BackgroundLaunchParams,
		signal: AbortSignal,
	): Promise<void> {
		let result: SubAgentResult | undefined;
		let failure: string | undefined;
		try {
			result = await this.slots.run(() => params.run(signal));
		} catch (err) {
			failure = errorMessage(err);
		}

		const run = this.runs.get(id);
		if (!run) return;
		run.snapshot = {
			...run.snapshot,
			status: signal.aborted
				? "cancelled"
				: (result?.status ?? (failure ? "failed" : "completed")),
			rounds: result?.toolRounds ?? run.snapshot.rounds,
			finishedAt: Date.now(),
		};
		this.bus.emit({
			type: "agent:background_finished",
			run: run.snapshot,
		});

		// A cancelled run was stopped deliberately; re-entering the loop to
		// announce it would talk over whatever the user cancelled it for.
		if (signal.aborted) return;
		this.notifier?.(
			backgroundReportMessage(run.snapshot, result?.report ?? failure ?? ""),
		);
	}
}

/**
 * The message injected back into the parent loop. It carries elapsed time
 * explicitly because the workspace may have moved on while the agent ran —
 * the parent must not assume its own earlier reads are still current.
 */
export function backgroundReportMessage(
	run: BackgroundRunSnapshot,
	report: string,
): string {
	const elapsedS = Math.max(
		1,
		Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
	);
	return `<agent-report agent="${run.agent}" status="${run.status}" rounds="${run.rounds}" elapsed="${elapsedS}s">
${report.trim()}
</agent-report>

The background agent "${run.agent}" you launched has finished; the report above is its output. It ran for ${elapsedS}s, so files you read before launching it may have changed — re-read anything you are about to act on. Continue the work this report was for, or tell the user what it found.`;
}
