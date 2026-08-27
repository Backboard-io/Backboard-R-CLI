import { type ChildProcess, spawn } from "node:child_process";
import { errorMessage } from "../../utils/errors.ts";

export interface HelperProcessOptions {
	command: string;
	args?: string[];
	/** Milliseconds a single request may take before it is rejected. */
	requestTimeoutMs?: number;
	/** Human-readable name used in error messages. */
	label?: string;
	/** Bytes of stderr kept for diagnostics when the process dies. */
	stderrLimit?: number;
}

interface Pending {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	cleanup: () => void;
	onSettle?: () => void;
}

/**
 * A long-lived native helper spoken to over JSON lines on stdin/stdout. One
 * request per line, one response per line, matched by `id`. The process is
 * spawned lazily and respawned if it exits, so a crash costs one request, not
 * the session.
 */
export class HelperProcess {
	private child: ChildProcess | null = null;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private drain: Promise<void> = Promise.resolve();
	private stderr = "";
	private disposed = false;

	constructor(private readonly options: HelperProcessOptions) {}

	get isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null;
	}

	async request<T extends object = Record<string, unknown>>(
		body: Record<string, unknown>,
		options: { signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<T> {
		await this.waitForDrain();
		if (this.disposed) {
			throw new Error(`${this.label} has been disposed`);
		}
		if (options.signal?.aborted) throw new Error("aborted");
		const child = this.ensureChild();
		const id = this.nextId++;
		const timeoutMs =
			options.timeoutMs ?? this.options.requestTimeoutMs ?? 20_000;
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => {
				this.abortRequest(id, new Error("aborted"));
			};
			const timer = setTimeout(() => {
				this.cancelRequest(
					id,
					new Error(
						`${this.label} did not answer "${String(body.op ?? "request")}" within ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timer,
				cleanup: () => options.signal?.removeEventListener("abort", onAbort),
			});
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.signal?.aborted) {
				this.settle(id);
				reject(new Error("aborted"));
				return;
			}
			const line = `${JSON.stringify({ id, ...body })}\n`;
			child.stdin?.write(line, (err) => {
				if (err) {
					this.settle(id);
					reject(new Error(`${this.label} stdin write failed: ${err.message}`));
				}
			});
		});
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.waitForDrain();
		this.failAll(new Error(`${this.label} was disposed`));
		const child = this.child;
		this.child = null;
		if (!child) return;
		child.stdin?.end();
		if (child.exitCode === null) child.kill();
	}

	private get label(): string {
		return this.options.label ?? this.options.command;
	}

	private async waitForDrain(): Promise<void> {
		while (true) {
			const drain = this.drain;
			await drain;
			if (drain === this.drain) return;
		}
	}

	private ensureChild(): ChildProcess {
		if (this.child && this.child.exitCode === null) return this.child;
		const child = spawn(this.options.command, this.options.args ?? [], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		this.buffer = "";
		this.stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (this.child === child) this.onData(chunk);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			if (this.child !== child) return;
			const limit = this.options.stderrLimit ?? 4000;
			this.stderr = (this.stderr + chunk).slice(-limit);
		});
		child.on("error", (err) => {
			if (this.child !== child) return;
			this.child = null;
			this.failAll(new Error(`${this.label} failed to start: ${err.message}`));
		});
		child.on("close", (code) => {
			if (this.child !== child) return;
			this.child = null;
			const detail = this.stderr.trim();
			this.failAll(
				new Error(
					`${this.label} exited with code ${code ?? "null"}${detail ? `: ${detail}` : ""}`,
				),
			);
		});
		return child;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).trim();
			this.buffer = this.buffer.slice(index + 1);
			if (line) this.onLine(line);
			index = this.buffer.indexOf("\n");
		}
	}

	private onLine(line: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch (err) {
			// Diagnostic noise on stdout is not fatal; keep it for error messages.
			this.stderr = `${this.stderr}\n${line}`.slice(-4000);
			void errorMessage(err);
			return;
		}
		const id = typeof message.id === "number" ? message.id : null;
		if (id === null) return;
		const entry = this.pending.get(id);
		if (!entry) return;
		this.settle(id);
		if (message.ok === false) {
			entry.reject(
				new Error(
					typeof message.error === "string"
						? message.error
						: `${this.label} request failed`,
				),
			);
			return;
		}
		entry.resolve(message);
	}

	private settle(id: number): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		entry.cleanup();
		this.pending.delete(id);
		entry.onSettle?.();
	}

	private cancelRequest(id: number, error: Error): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		this.settle(id);
		entry.reject(error);
		const child = this.child;
		if (!child) return;
		this.child = null;
		this.failAll(
			new Error(`${this.label} restarted after a cancelled request`),
		);
		if (child.exitCode === null) child.kill();
	}

	private abortRequest(id: number, error: Error): void {
		const entry = this.pending.get(id);
		if (!entry) return;
		let releaseDrain: () => void = () => {};
		const draining = new Promise<void>((resolve) => {
			releaseDrain = resolve;
		});
		this.drain = this.drain.then(() => draining);
		entry.cleanup();
		entry.reject(error);
		// Let the in-flight native action finish so any key-down or mouse-down
		// event reaches its matching release. Keep the timeout armed so a truly
		// hung helper is still restarted.
		this.pending.set(id, {
			...entry,
			resolve: () => {},
			reject: () => {},
			cleanup: () => {},
			onSettle: releaseDrain,
		});
	}

	private failAll(error: Error): void {
		for (const [id, entry] of [...this.pending]) {
			this.settle(id);
			entry.reject(error);
		}
	}
}
