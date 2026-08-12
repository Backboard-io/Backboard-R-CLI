import type { AgentEvent, AgentEventType } from "./events.ts";

type Listener<E extends AgentEvent = AgentEvent> = (event: E) => void;
type AnyListener = (event: AgentEvent) => void;

type EventOfType<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;

/**
 * Typed, synchronous publish/subscribe hub. Synchronous delivery keeps the
 * client event log perfectly ordered with what the UI sees. Listeners must not
 * throw; errors are isolated so one bad subscriber cannot break the run.
 */
export class EventBus {
	private readonly typed = new Map<AgentEventType, Set<Listener>>();
	private readonly all = new Set<AnyListener>();

	on<T extends AgentEventType>(
		type: T,
		listener: Listener<EventOfType<T>>,
	): () => void {
		let set = this.typed.get(type);
		if (!set) {
			set = new Set();
			this.typed.set(type, set);
		}
		set.add(listener as Listener);
		return () => set.delete(listener as Listener);
	}

	onAny(listener: AnyListener): () => void {
		this.all.add(listener);
		return () => this.all.delete(listener);
	}

	emit(event: AgentEvent): void {
		const set = this.typed.get(event.type);
		if (set) {
			for (const listener of set) {
				safeInvoke(listener, event);
			}
		}
		for (const listener of this.all) {
			safeInvoke(listener, event);
		}
	}

	clear(): void {
		this.typed.clear();
		this.all.clear();
	}
}

function safeInvoke(listener: AnyListener, event: AgentEvent): void {
	try {
		listener(event);
	} catch {
		// Subscriber errors are swallowed so a single faulty listener cannot
		// abort event delivery to the rest of the system.
	}
}
