import { appendFile, open } from "node:fs/promises";
import { appendLine } from "../../utils/fs.ts";

/**
 * Append-only JSONL writer with serialized, ordered writes. Callers enqueue
 * synchronously (from sync contexts like EventBus.emit) and the writer chains
 * the underlying async appends so on-disk order matches enqueue order. Call
 * `flush()` before exit to guarantee durability.
 */
export class JsonlWriter {
	private tail: Promise<void>;

	constructor(private readonly filePath: string) {
		this.tail = ensureAppendBoundary(filePath);
		this.observeTail();
	}

	write(record: object): void {
		const line = JSON.stringify(record);
		this.tail = this.tail.then(
			() => appendLine(this.filePath, line),
			() => appendLine(this.filePath, line),
		);
		this.observeTail();
	}

	async flush(): Promise<void> {
		await this.tail;
	}

	private observeTail(): void {
		void this.tail.catch(() => undefined);
	}
}

async function ensureAppendBoundary(filePath: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return;
		throw error;
	}
	try {
		const size = (await handle.stat()).size;
		if (size === 0) return;
		const lastByte = Buffer.alloc(1);
		const { bytesRead } = await handle.read(lastByte, 0, 1, size - 1);
		if (bytesRead === 1 && lastByte[0] !== 10) {
			await appendFile(filePath, "\n", "utf8");
		}
	} finally {
		await handle.close();
	}
}
