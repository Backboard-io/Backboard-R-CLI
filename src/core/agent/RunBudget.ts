export class RunTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Run timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
		this.name = "RunTimeoutError";
	}
}

export interface RunBudgetOptions {
	/**
	 * False keeps the run alive past the deadline; await `expiry` instead. A
	 * function is consulted when the deadline fires, for a run whose waiter
	 * may have gone away (moved to the background) since it started.
	 */
	abortOnExpiry?: boolean | (() => boolean);
}

/**
 * A wall-clock budget over a parent AbortSignal. Expiry is distinguishable from
 * a parent cancel, so callers can degrade instead of discarding the run's work.
 */
export class RunBudget {
	private readonly controller = new AbortController();
	private readonly timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly abortFromParent: () => void;
	private readonly deadlineMs: number;
	private readonly abortOnExpiry: () => boolean;
	private signalExpiry!: () => void;
	private expired = false;
	private detached = false;

	/** Resolves once the deadline passes. Never rejects; never resolves without one. */
	readonly expiry: Promise<void>;

	private constructor(
		private readonly parentSignal: AbortSignal,
		readonly timeoutMs?: number,
		options: RunBudgetOptions = {},
	) {
		const abortOnExpiry = options.abortOnExpiry ?? true;
		this.abortOnExpiry =
			typeof abortOnExpiry === "function" ? abortOnExpiry : () => abortOnExpiry;
		this.expiry = new Promise<void>((resolve) => {
			this.signalExpiry = resolve;
		});
		this.deadlineMs =
			timeoutMs === undefined
				? Number.POSITIVE_INFINITY
				: Date.now() + timeoutMs;
		this.abortFromParent = (): void => {
			this.controller.abort(parentSignal.reason);
		};
		if (parentSignal.aborted) {
			this.abortFromParent();
		} else {
			parentSignal.addEventListener("abort", this.abortFromParent, {
				once: true,
			});
		}

		if (timeoutMs !== undefined) {
			this.timeout = setTimeout(() => {
				this.expired = true;
				if (this.abortOnExpiry()) {
					this.controller.abort(new RunTimeoutError(timeoutMs));
				}
				this.signalExpiry();
			}, timeoutMs);
		}
	}

	static start(
		parentSignal: AbortSignal,
		timeoutMs?: number,
		options: RunBudgetOptions = {},
	): RunBudget {
		return new RunBudget(parentSignal, timeoutMs, options);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** True only for budget expiry; a parent cancel reports false. */
	get timedOut(): boolean {
		return this.expired && !this.parentSignal.aborted;
	}

	cancel(reason?: unknown): void {
		this.controller.abort(reason);
	}

	/** Enforces the deadline late, for a caller that declined the handoff. */
	abortForTimeout(): void {
		this.expired = true;
		this.controller.abort(new RunTimeoutError(this.timeoutMs ?? 0));
		this.signalExpiry();
	}

	/** Stops forwarding the parent's cancel, for a run that outlives its turn. */
	detachFromParent(): void {
		if (this.detached) return;
		this.detached = true;
		this.parentSignal.removeEventListener("abort", this.abortFromParent);
	}

	get remainingMs(): number | undefined {
		if (this.timeoutMs === undefined) return undefined;
		if (this.expired) return 1;
		return Math.max(1, this.deadlineMs - Date.now());
	}

	throwIfExpired(): void {
		if (this.expired) throw new RunTimeoutError(this.timeoutMs ?? 0);
		if (this.signal.aborted && !this.parentSignal.aborted) {
			throw this.signal.reason instanceof Error
				? this.signal.reason
				: new RunTimeoutError(this.timeoutMs ?? 0);
		}
	}

	isTimeoutError(error: Error): boolean {
		return (
			error instanceof RunTimeoutError ||
			(!this.parentSignal.aborted && this.signal.aborted && this.expired)
		);
	}

	dispose(): void {
		if (this.timeout) clearTimeout(this.timeout);
		this.detachFromParent();
	}
}
