import type { EventBus } from "../bus/EventBus.ts";
import type { AgentEvent } from "../bus/events.ts";

export interface JsonEventRecord {
	timestamp: string;
	session_id: string;
	sequence: number;
	source: "client";
	type: AgentEvent["type"];
	payload: AgentEvent;
}

/**
 * Streams the complete client event trace to stdout as JSONL. This is intended
 * for debugging and automation, so stdout stays machine-readable in JSON mode.
 */
export class JsonEventStream {
	private sequence = 0;
	private unsubscribe: (() => void) | null = null;

	constructor(private sessionId: string) {}

	activate(sessionId: string): void {
		if (sessionId === this.sessionId) return;
		this.sessionId = sessionId;
	}

	attach(bus: EventBus): void {
		if (this.unsubscribe) return;
		this.unsubscribe = bus.onAny((event) => this.write(event));
	}

	detach(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private write(event: AgentEvent): void {
		const record: JsonEventRecord = {
			timestamp: new Date().toISOString(),
			session_id: this.sessionId,
			sequence: this.sequence++,
			source: "client",
			type: event.type,
			payload: event,
		};
		process.stdout.write(`${JSON.stringify(record)}\n`);
	}
}
