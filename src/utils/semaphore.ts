/** Caps concurrent holders. Acquisitions are granted FIFO. */
export class Semaphore {
	private available: number;
	private readonly waiting: Array<() => void> = [];

	constructor(permits: number) {
		if (!Number.isInteger(permits) || permits < 1) {
			throw new Error("Semaphore requires at least one permit");
		}
		this.available = permits;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		await this.acquire();
		try {
			return await fn();
		} finally {
			this.release();
		}
	}

	private acquire(): Promise<void> {
		if (this.available > 0) {
			this.available--;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiting.push(resolve);
		});
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) {
			next();
			return;
		}
		this.available++;
	}
}
