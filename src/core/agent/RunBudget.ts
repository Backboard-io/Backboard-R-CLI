export class RunTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Run timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
		this.name = "RunTimeoutError";
	}
}

/**
 * A wall-clock budget layered over a parent AbortSignal. Expiry is
 * distinguishable from a parent cancel so callers can degrade gracefully —
 * summarizing partial progress — instead of discarding the run's work.
 */
export class RunBudget {
	private readonly controller = new AbortController();
	private readonly timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly abortFromParent: () => void;
	private readonly deadlineMs: number;
	private expired = false;

	private constructor(
		private readonly parentSignal: AbortSignal,
		readonly timeoutMs?: number,
	) {
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
				this.controller.abort(new RunTimeoutError(timeoutMs));
			}, timeoutMs);
		}
	}

	static start(parentSignal: AbortSignal, timeoutMs?: number): RunBudget {
		return new RunBudget(parentSignal, timeoutMs);
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** True only for budget expiry; a parent cancel reports false. */
	get timedOut(): boolean {
		return this.expired && !this.parentSignal.aborted;
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
		this.parentSignal.removeEventListener("abort", this.abortFromParent);
	}
}
