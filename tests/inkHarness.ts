import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

export interface InkTty {
	stdout: Writable & { columns: number; rows: number; isTTY: boolean };
	stdin: NodeJS.ReadStream;
	/** Queue a keystroke/chunk and notify Ink (which reads via 'readable'). */
	feed: (chunk: string) => void;
	/** Everything Ink has written to stdout so far. */
	written: () => string;
}

/**
 * A fake TTY for rendering Ink components in tests. Ink reads input through the
 * 'readable' event plus stdin.read(), so `read()` is backed by a queue that
 * `feed()` pushes to.
 */
export function makeInkTty(columns = 80, rows = 24): InkTty {
	let data = "";
	const stdout = new Writable({
		write(chunk, _encoding, done) {
			data += chunk.toString();
			done();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	stdout.columns = columns;
	stdout.rows = rows;
	stdout.isTTY = true;

	const queue: string[] = [];
	const stdin = Object.assign(new EventEmitter(), {
		isTTY: true,
		setRawMode: () => stdin,
		ref: () => stdin,
		unref: () => stdin,
		read: () => (queue.length > 0 ? queue.shift() : null),
		setEncoding: () => stdin,
		resume: () => stdin,
		pause: () => stdin,
	});

	const feed = (chunk: string): void => {
		queue.push(chunk);
		stdin.emit("readable");
	};

	return {
		stdout,
		stdin: stdin as unknown as NodeJS.ReadStream,
		feed,
		written: () => data,
	};
}
