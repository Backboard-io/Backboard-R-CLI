import { open } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_SEQUENCE_LINE_BYTES = 1024 * 1024;

export async function nextJsonlSequence(filePath: string): Promise<number> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return 0;
		throw error;
	}
	try {
		const fileSize = (await handle.stat()).size;
		let end = fileSize;
		let trailingChunks: Buffer[] = [];
		let trailingBytes = 0;
		let trailingTerminated = false;
		let trailingTruncated = false;
		while (end > 0) {
			const start = Math.max(0, end - READ_CHUNK_BYTES);
			const buffer = Buffer.alloc(end - start);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const result = await handle.read(
					buffer,
					bytesRead,
					buffer.length - bytesRead,
					start + bytesRead,
				);
				if (result.bytesRead === 0) break;
				bytesRead += result.bytesRead;
			}
			const chunk = buffer.subarray(0, bytesRead);
			if (end === fileSize && chunk.at(-1) === 10) {
				trailingTerminated = true;
			}
			let lineEnd = chunk.length;
			let newline = chunk.lastIndexOf(10, lineEnd - 1);
			while (newline >= 0) {
				const sequence = parseSequence(
					Buffer.concat([
						chunk.subarray(newline + 1, lineEnd),
						...trailingChunks,
					]).toString("utf8"),
					trailingTerminated && trailingTruncated,
				);
				if (sequence !== null) return sequence + 1;
				trailingChunks = [];
				trailingBytes = 0;
				trailingTerminated = true;
				trailingTruncated = false;
				lineEnd = newline;
				if (lineEnd === 0) break;
				newline = chunk.lastIndexOf(10, lineEnd - 1);
			}
			if (lineEnd > 0) {
				const prefix = chunk.subarray(0, lineEnd);
				trailingChunks.unshift(prefix);
				trailingBytes += prefix.length;
				while (trailingBytes > MAX_SEQUENCE_LINE_BYTES) {
					trailingTruncated = true;
					const last = trailingChunks.at(-1);
					if (!last) break;
					const excess = trailingBytes - MAX_SEQUENCE_LINE_BYTES;
					if (last.length <= excess) {
						trailingChunks.pop();
						trailingBytes -= last.length;
					} else {
						trailingChunks[trailingChunks.length - 1] = last.subarray(
							0,
							last.length - excess,
						);
						trailingBytes -= excess;
					}
				}
			}
			if (start === 0 && trailingChunks.length > 0) {
				const sequence = parseSequence(
					Buffer.concat(trailingChunks).toString("utf8"),
					trailingTerminated && trailingTruncated,
				);
				if (sequence !== null) return sequence + 1;
			}
			end = start;
		}
		return 0;
	} finally {
		await handle.close();
	}
}

function parseSequence(
	line: string,
	allowTruncatedPrefix = false,
): number | null {
	if (!line) return null;
	try {
		const value = JSON.parse(line) as { sequence?: unknown };
		if (
			typeof value.sequence === "number" &&
			Number.isInteger(value.sequence) &&
			value.sequence >= 0
		) {
			return value.sequence;
		}
	} catch {
		// Ignore a partial/corrupt tail and continue from the last valid record.
	}
	if (allowTruncatedPrefix) {
		const match = /"sequence"\s*:\s*(\d+)/.exec(line);
		if (match) {
			const sequence = Number(match[1]);
			if (Number.isSafeInteger(sequence)) return sequence;
		}
	}
	return null;
}
