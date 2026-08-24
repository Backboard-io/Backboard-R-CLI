import type { EventBus } from "../bus/EventBus.ts";
import {
	type SessionPaths,
	sessionPathsForRoot,
} from "../session/SessionStore.ts";
import {
	type CapturedEntry,
	type CheckpointCallContext,
	type CheckpointRecorder,
	CheckpointStore,
	type RecordPreImageOptions,
	scopeCheckpointRecorder,
} from "./CheckpointStore.ts";
import type {
	CheckpointSummary,
	RestorePlan,
	RestoreResult,
} from "./journalTypes.ts";

/** Switchable checkpoint facade used when `/sessions` resumes another local run. */
export class CheckpointManager implements CheckpointRecorder {
	private active: CheckpointStore;

	constructor(
		private readonly bus: EventBus,
		paths: SessionPaths,
		private readonly cwd: string,
	) {
		this.active = new CheckpointStore(paths, bus);
	}

	get paths(): SessionPaths {
		return this.active.paths;
	}

	get activeRoot(): string {
		return this.active.paths.root;
	}

	async activateRoot(root: string): Promise<void> {
		if (root === this.activeRoot) return;
		const previous = this.active;
		await previous.flush();
		const paths = sessionPathsForRoot(root);
		await CheckpointStore.recoverAbandonedRestore(paths.pendingUndo);
		const next = new CheckpointStore(paths, this.bus);
		next.warmShellCapture(this.cwd);
		this.active = next;
		previous.dispose();
	}

	warmShellCapture(cwd: string): void {
		this.active.warmShellCapture(cwd);
	}

	async flush(): Promise<void> {
		await this.active.flush();
	}

	async dispose(): Promise<void> {
		await this.active.flush();
		this.active.dispose();
	}

	listCheckpoints(): CheckpointSummary[] {
		return this.active.listCheckpoints();
	}

	undoTarget(): string | null {
		return this.active.undoTarget();
	}

	redoTarget(): string | null {
		return this.active.redoTarget();
	}

	planRestore(checkpointId: string): Promise<RestorePlan> {
		return this.active.planRestore(checkpointId);
	}

	restore(
		plan: RestorePlan,
		opts: { skipDiverged: boolean },
	): Promise<RestoreResult> {
		return this.active.restore(plan, opts);
	}

	recordPreImage(
		absPath: string,
		ctx: CheckpointCallContext,
		opts?: RecordPreImageOptions,
	): Promise<void> {
		return this.active.recordPreImage(absPath, ctx, opts);
	}

	recordPostImage(
		absPath: string,
		ctx: CheckpointCallContext,
		contentIfInMemory?: Uint8Array,
	): Promise<void> {
		return this.active.recordPostImage(absPath, ctx, contentIfInMemory);
	}

	revokeCapture(entry: CapturedEntry): Promise<void> {
		return this.active.revokeCapture(entry);
	}

	revertToolCall(toolCallId: string): Promise<void> {
		return this.active.revertToolCall(toolCallId);
	}

	beginShellCapture(cwd: string, ctx: CheckpointCallContext): Promise<void> {
		return this.active.beginShellCapture(cwd, ctx);
	}

	endShellCapture(ctx: CheckpointCallContext): Promise<void> {
		return this.active.endShellCapture(ctx);
	}

	captureWarning(): string | null {
		return this.active.captureWarning();
	}

	scopedToTurn(turnId: string): CheckpointRecorder {
		return scopeCheckpointRecorder(this, turnId);
	}
}
