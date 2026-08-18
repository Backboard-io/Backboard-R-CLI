export class SemaphoreAbortError extends Error {
	constructor() {
		super("aborted while queued");
		this.name = "SemaphoreAbortError";
	}
}

/** Caps concurrent holders. Acquisitions are granted FIFO. */
export class Semaphore {
	private available: number;
	private readonly waiting: Array<{
		grant: () => void;
		reject: (err: Error) => void;
	}> = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) {
			throw new Error("Semaphore requires at least one permit");
		}
		this.available = permits;
	}

	async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.acquire(signal);
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.reject(new SemaphoreAbortError());
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const entry = {
				grant: () => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				},
				reject,
			};
			const onAbort = (): void => {
				const index = this.waiting.indexOf(entry);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(new SemaphoreAbortError());
			};
			this.waiting.push(entry);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) {
			next.grant();
			return;
		}
		this.available++;
	}
}
