import type { EventBus } from "../bus/EventBus.ts";
import type { AgentEvent } from "../bus/events.ts";
import { nextJsonlSequence } from "./JsonlSequence.ts";
import { JsonlWriter } from "./JsonlWriter.ts";

export interface ClientLogRecord {
	timestamp: string;
	session_id: string;
	sequence: number;
	source: "client";
	type: AgentEvent["type"];
	payload: AgentEvent;
}

/**
 * Subscribes to every bus event and appends a timestamped JSONL record. This is
 * the complete local-side trace of a run: UI events, user input, agent loop
 * state, scheduler decisions, tool lifecycle, cancellations, errors, usage, and
 * todos. Subscribe immediately after the bus is created so nothing is missed.
 */
export class ClientEventLog {
	private writer: JsonlWriter;
	private sequence = 0;
	private unsubscribe: (() => void) | null = null;
	private pendingDuringActivation: AgentEvent[] | null = null;

	constructor(
		private sessionId: string,
		filePath: string,
	) {
		this.writer = new JsonlWriter(filePath);
	}

	async activate(sessionId: string, filePath: string): Promise<void> {
		if (sessionId === this.sessionId) return;
		if (this.pendingDuringActivation) {
			throw new Error("Client event log activation is already in progress.");
		}
		const pending: AgentEvent[] = [];
		this.pendingDuringActivation = pending;
		try {
			const sequence = await nextJsonlSequence(filePath);
			await this.writer.flush();
			this.sessionId = sessionId;
			this.sequence = sequence;
			this.writer = new JsonlWriter(filePath);
			this.pendingDuringActivation = null;
			for (const event of pending) this.record(event);
		} catch (error) {
			this.pendingDuringActivation = null;
			for (const event of pending) this.record(event);
			throw error;
		}
	}

	attach(bus: EventBus): void {
		if (this.unsubscribe) return;
		this.unsubscribe = bus.onAny((event) => this.record(event));
	}

	private record(event: AgentEvent): void {
		if (this.pendingDuringActivation) {
			this.pendingDuringActivation.push(event);
			return;
		}
		const record: ClientLogRecord = {
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			sequence: this.sequence++,
			source: "client",
			type: event.type,
			payload: event,
		};
		this.writer.write(record);
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	async flush(): Promise<void> {
		await this.writer.flush();
	}
}
