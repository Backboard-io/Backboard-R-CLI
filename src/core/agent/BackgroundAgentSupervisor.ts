import { errorMessage } from "../../utils/errors.ts";
import { shortId } from "../../utils/id.ts";
import { Semaphore } from "../../utils/semaphore.ts";
import { truncate } from "../../utils/string.ts";
import type { AgentDefinition } from "../agents/AgentDefinition.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { BackgroundRunSnapshot } from "../bus/events.ts";
import {
	formatSpawnTree,
	type SpawnedAgent,
} from "../tools/AgentToolOutput.ts";
import type { SubAgentResult } from "./SubAgentTypes.ts";

export const DEFAULT_BACKGROUND_MAX_CONCURRENT = 4;
const LABEL_LENGTH = 60;

export interface BackgroundLaunchParams {
	definition: AgentDefinition;
	prompt: string;
	run: (signal: AbortSignal) => Promise<SubAgentResult>;
}

export interface BackgroundAdoptParams {
	definition: AgentDefinition;
	prompt: string;
	continuation: Promise<SubAgentResult>;
	/** Stops the run. An adopted run has no signal of the supervisor's own. */
	cancel: () => void;
}

interface BackgroundRun {
	snapshot: BackgroundRunSnapshot;
	stop: () => void;
	/** Set by cancelAll, so the run does not announce a result nobody asked for. */
	stopped?: boolean;
}

/**
 * Owns sub-agents that outlive the turn that spawned them. Runs are unlinked
 * from that turn's cancellation; `cancelAll` is the way to stop them.
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
		const abort = new AbortController();
		const { id, snapshot } = this.register(params, false);
		this.runs.set(id, { snapshot, stop: () => abort.abort() });
		this.bus.emit({ type: "agent:background_started", run: snapshot });

		void this.drive(id, params, abort.signal);
		return snapshot;
	}

	/** Takes over an in-flight run whose budget expired, without interrupting it. */
	adopt(params: BackgroundAdoptParams): BackgroundRunSnapshot {
		const { id, snapshot } = this.register(params, true);
		// An adopted run started under the turn's signal and has since been
		// detached from it, so stopping it means calling back into the runner.
		this.runs.set(id, { snapshot, stop: params.cancel });
		this.bus.emit({ type: "agent:background_started", run: snapshot });

		void this.driveAdopted(id, params.continuation);
		return snapshot;
	}

	private register(
		params: { definition: AgentDefinition; prompt: string },
		adopted: boolean,
	): { id: string; snapshot: BackgroundRunSnapshot } {
		const id = shortId("bg");
		return {
			id,
			snapshot: {
				id,
				agent: params.definition.name,
				label: truncate(
					params.prompt.replace(/\s+/gu, " ").trim(),
					LABEL_LENGTH,
				),
				status: "running",
				startedAt: Date.now(),
				rounds: 0,
				...(adopted ? { adopted: true } : {}),
			},
		};
	}

	private async driveAdopted(
		id: string,
		continuation: Promise<SubAgentResult>,
	): Promise<void> {
		let result: SubAgentResult | undefined;
		let failure: string | undefined;
		try {
			result = await continuation;
		} catch (err) {
			failure = errorMessage(err);
		}
		this.finish(id, result, failure, false);
	}

	cancelAll(): void {
		for (const run of this.runs.values()) {
			if (run.snapshot.status !== "running") continue;
			run.stopped = true;
			run.stop();
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
			result = await this.slots.run(() => params.run(signal), signal);
		} catch (err) {
			failure = errorMessage(err);
		}

		this.finish(id, result, failure, signal.aborted);
	}

	private finish(
		id: string,
		result: SubAgentResult | undefined,
		failure: string | undefined,
		cancelled: boolean,
	): void {
		const run = this.runs.get(id);
		if (!run) return;
		const wasCancelled = cancelled || run.stopped === true;
		run.snapshot = {
			...run.snapshot,
			status: wasCancelled
				? "cancelled"
				: (result?.status ?? (failure ? "failed" : "completed")),
			rounds: result?.toolRounds ?? run.snapshot.rounds,
			finishedAt: Date.now(),
		};
		this.bus.emit({
			type: "agent:background_finished",
			run: run.snapshot,
		});

		const snapshot = run.snapshot;
		this.runs.delete(id);
		if (wasCancelled) return;
		this.notifier?.(
			backgroundReportMessage(
				snapshot,
				result?.report ?? failure ?? "",
				result?.children ?? [],
			),
		);
	}
}

/** Carries elapsed time, since the workspace may have moved on while it ran. */
export function backgroundReportMessage(
	run: BackgroundRunSnapshot,
	report: string,
	children: readonly SpawnedAgent[] = [],
): string {
	const tree = children.length
		? `\n\nSub-agents it spawned:\n${formatSpawnTree(children)}`
		: "";
	const elapsedS = Math.max(
		1,
		Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000),
	);
	return `<agent-report agent="${run.agent}" status="${run.status}" rounds="${run.rounds}" elapsed="${elapsedS}s">
${report.trim()}${tree}
</agent-report>

The background agent "${run.agent}" you launched has finished; the report above is its output. It ran for ${elapsedS}s, so files you read before launching it may have changed — re-read anything you are about to act on. Continue the work this report was for, or tell the user what it found.`;
}
