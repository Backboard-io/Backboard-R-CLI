import { nextJsonlSequence } from "./JsonlSequence.ts";
import { JsonlWriter } from "./JsonlWriter.ts";

export interface ServerRequestRecord {
	timestamp: string;
	session_id: string;
	sequence: number;
	source: "server";
	type: "request";
	endpoint: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export interface ServerResponseRecord {
	timestamp: string;
	session_id: string;
	sequence: number;
	source: "server";
	type: "response";
	endpoint: string;
	method: string;
	status: number;
	body: unknown;
	latency_ms: number;
	error?: string;
}

const REDACTED = "<redacted>";
const SENSITIVE_HEADERS = new Set([
	"x-api-key",
	"authorization",
	"x-session-token",
]);

/**
 * Records every Backboard HTTP exchange as timestamped JSONL. Sensitive headers
 * (API key, auth, session token) are redacted before writing so secrets never
 * land on disk.
 */
export class ServerEventLog {
	private writer: JsonlWriter;
	private sequence = 0;
	private pendingDuringActivation: Array<() => void> | null = null;

	constructor(
		private sessionId: string,
		filePath: string,
	) {
		this.writer = new JsonlWriter(filePath);
	}

	async activate(sessionId: string, filePath: string): Promise<void> {
		if (sessionId === this.sessionId) return;
		if (this.pendingDuringActivation) {
			throw new Error("Server event log activation is already in progress.");
		}
		const pending: Array<() => void> = [];
		this.pendingDuringActivation = pending;
		try {
			const sequence = await nextJsonlSequence(filePath);
			await this.writer.flush();
			this.sessionId = sessionId;
			this.sequence = sequence;
			this.writer = new JsonlWriter(filePath);
			this.pendingDuringActivation = null;
			for (const write of pending) write();
		} catch (error) {
			this.pendingDuringActivation = null;
			for (const write of pending) write();
			throw error;
		}
	}

	request(input: {
		endpoint: string;
		method: string;
		headers: Record<string, string>;
		body: unknown;
	}): void {
		if (this.pendingDuringActivation) {
			this.pendingDuringActivation.push(() => this.request(input));
			return;
		}
		const record: ServerRequestRecord = {
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			sequence: this.sequence++,
			source: "server",
			type: "request",
			endpoint: input.endpoint,
			method: input.method,
			headers: redactHeaders(input.headers),
			body: input.body,
		};
		this.writer.write(record);
	}

	response(input: {
		endpoint: string;
		method: string;
		status: number;
		body: unknown;
		latencyMs: number;
		error?: string;
	}): void {
		if (this.pendingDuringActivation) {
			this.pendingDuringActivation.push(() => this.response(input));
			return;
		}
		const record: ServerResponseRecord = {
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			sequence: this.sequence++,
			source: "server",
			type: "response",
			endpoint: input.endpoint,
			method: input.method,
			status: input.status,
			body: input.body,
			latency_ms: input.latencyMs,
			...(input.error ? { error: input.error } : {}),
		};
		this.writer.write(record);
	}

	async flush(): Promise<void> {
		await this.writer.flush();
	}
}

function redactHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
	}
	return out;
}
