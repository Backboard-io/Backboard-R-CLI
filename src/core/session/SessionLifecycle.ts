import { join } from "node:path";
import type { Config } from "../../config/Config.ts";
import { qSessionDir } from "../../config/paths.ts";
import { acquireFileLease, type FileLease } from "../../utils/FileLease.ts";
import { shortId } from "../../utils/id.ts";
import type { CheckpointManager } from "../checkpoints/CheckpointManager.ts";
import {
	SESSION_LEASE_FILE,
	SESSION_LEASE_INVALID_OWNER_STALE_MS,
	SESSION_LEASE_RETRY_MS,
	SESSION_LEASE_TIMEOUT_MS,
} from "./SessionLifecycle.constants.ts";
import {
	type SessionPaths,
	SessionStore,
	sessionPathsForRoot,
} from "./SessionStore.ts";

export class SessionLifecycle {
	private currentSessionId: string;
	private currentSessionRoot: string;
	private replacedThreadId: string | null = null;
	private lease: FileLease | null = null;

	constructor(
		private readonly config: Config,
		private readonly checkpoints: CheckpointManager,
		initial: SessionStore,
		private readonly onActivate?: (
			sessionId: string,
			paths: SessionPaths,
		) => Promise<void>,
	) {
		this.currentSessionId = initial.sessionId;
		this.currentSessionRoot = initial.paths.root;
	}

	async initialize(): Promise<void> {
		this.lease = await this.acquireLease(this.currentSessionRoot);
	}

	current(): {
		sessionId: string;
		sessionRoot: string;
		replacesThreadId?: string;
	} {
		return {
			sessionId: this.currentSessionId,
			sessionRoot: this.currentSessionRoot,
			...(this.replacedThreadId
				? { replacesThreadId: this.replacedThreadId }
				: {}),
		};
	}

	replaceThread(threadId: string | null): void {
		this.replacedThreadId = threadId;
	}

	async startNew(): Promise<void> {
		const sessionId = shortId("sess");
		const store = new SessionStore(sessionId, this.config.cwd);
		await store.init({
			sessionId,
			createdAt: new Date().toISOString(),
			cwd: this.config.cwd,
			model: this.config.modelString,
			profile: this.config.profile.name,
		});
		await this.activate(sessionId, store.paths.root);
	}

	async resume(sessionId: string): Promise<void> {
		await this.activate(sessionId, qSessionDir(this.config.cwd, sessionId));
	}

	async dispose(): Promise<void> {
		await this.lease?.release();
		this.lease = null;
	}

	private async activate(sessionId: string, root: string): Promise<void> {
		if (root === this.currentSessionRoot) return;
		const nextLease = await this.acquireLease(root);
		const previousRoot = this.currentSessionRoot;
		let checkpointsActivated = false;
		try {
			await this.checkpoints.activateRoot(root);
			checkpointsActivated = true;
			await this.onActivate?.(sessionId, sessionPathsForRoot(root));
			const previousLease = this.lease;
			this.lease = nextLease;
			this.currentSessionId = sessionId;
			this.currentSessionRoot = root;
			this.replacedThreadId = null;
			await previousLease?.release();
		} catch (error) {
			if (checkpointsActivated) {
				try {
					await this.checkpoints.activateRoot(previousRoot);
				} catch (rollbackError) {
					await nextLease.release();
					throw new AggregateError(
						[error, rollbackError],
						`Failed to activate session ${sessionId} and restore the previous checkpoint root.`,
					);
				}
			}
			await nextLease.release();
			throw error;
		}
	}

	private acquireLease(root: string): Promise<FileLease> {
		return acquireFileLease(join(root, SESSION_LEASE_FILE), {
			label: `session ${root}`,
			timeoutMs: SESSION_LEASE_TIMEOUT_MS,
			retryMs: SESSION_LEASE_RETRY_MS,
			invalidOwnerStaleMs: SESSION_LEASE_INVALID_OWNER_STALE_MS,
		});
	}
}
