import type { EventBus } from "../bus/EventBus.ts";
import type { TodoItem, TurnStatus, UsageInfo } from "../bus/events.ts";
import { areTodosComplete, todosFromMessages } from "../todos/TodoList.ts";
import { canonicalToolName } from "../tools/names.ts";
import type { Message } from "./Message.ts";

/**
 * In-memory projection of a run. Holds the Backboard thread id, the message
 * transcript, accumulated usage, todos, and the current turn status. This is
 * the authoritative runtime state; the on-disk logs are the durable record.
 */
export class Session {
	threadId: string | null = null;
	assistantId: string | null = null;
	status: TurnStatus = "completed";

	private readonly messages: Message[] = [];
	private todoList: TodoItem[] = [];
	private todoWriteUsed = false;
	private contextTokensUsed = 0;
	private contextLimitReported: number | null = null;
	private lastCachedTokens = 0;
	private usageTotals: Required<
		Pick<UsageInfo, "inputTokens" | "outputTokens" | "totalTokens">
	> = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
	};

	constructor(readonly sessionId: string) {}

	addMessage(message: Message): void {
		this.messages.push(message);
	}

	hydrate(input: {
		threadId: string;
		assistantId?: string | null;
		messages: readonly Message[];
	}): void {
		this.threadId = input.threadId;
		this.assistantId = input.assistantId ?? null;
		this.status = "completed";
		this.messages.length = 0;
		this.messages.push(...input.messages);
		this.todoList = todosFromMessages(input.messages);
		// The resumed transcript proves whether TodoWrite ran, so the "not
		// called yet" reminder doesn't contradict visible history after resume.
		this.todoWriteUsed = input.messages.some(
			(message) =>
				message.role === "assistant" &&
				message.toolCalls.some(
					(call) => canonicalToolName(call.name) === "todo_write",
				),
		);
		this.usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		// Unknown until the resumed thread's next turn reports it.
		this.contextTokensUsed = 0;
		this.contextLimitReported = null;
		this.lastCachedTokens = 0;
	}

	/** Starts a fresh thread: drops the transcript, thread id, todos, and usage. */
	reset(): void {
		this.threadId = null;
		this.assistantId = null;
		this.status = "completed";
		this.messages.length = 0;
		this.todoList = [];
		this.todoWriteUsed = false;
		this.usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		this.contextTokensUsed = 0;
		this.lastCachedTokens = 0;
	}

	getMessages(): readonly Message[] {
		return this.messages;
	}

	setTodos(todos: readonly TodoItem[]): void {
		this.todoList = [...todos];
	}

	get todos(): readonly TodoItem[] {
		return this.todoList;
	}

	/** True once TodoWrite has run this session; gates the "not called yet" system-prompt reminder. */
	get hasUsedTodoWrite(): boolean {
		return this.todoWriteUsed;
	}

	attach(bus: EventBus): () => void {
		const unsubscribeTodos = bus.on("todos:updated", (event) => {
			this.todoWriteUsed = true;
			this.setTodos(event.todos);
		});
		const unsubscribeTurnStart = bus.on("turn:start", () => {
			if (areTodosComplete(this.todoList)) this.todoList = [];
		});
		return () => {
			unsubscribeTodos();
			unsubscribeTurnStart();
		};
	}

	addUsage(usage: UsageInfo): void {
		this.usageTotals.inputTokens += usage.inputTokens ?? 0;
		this.usageTotals.outputTokens += usage.outputTokens ?? 0;
		this.usageTotals.totalTokens += usage.totalTokens ?? 0;
		this.recordContext(usage);
	}

	/**
	 * Tracks how full the window is, from the only authoritative source there
	 * is: what the provider says the last request actually cost. Totals
	 * accumulate across the session, but context is a level, not a sum - each
	 * turn resends the conversation, so the newest prompt size *is* the current
	 * occupancy. Compression and the `/context` readout both read this.
	 */
	private recordContext(usage: UsageInfo): void {
		const prompt = usage.contextTokens ?? usage.inputTokens;
		if (typeof prompt === "number" && prompt > 0) {
			this.contextTokensUsed = prompt;
		}
		if (typeof usage.contextLimit === "number" && usage.contextLimit > 0) {
			this.contextLimitReported = usage.contextLimit;
		}
		if (typeof usage.cachedTokens === "number") {
			this.lastCachedTokens = usage.cachedTokens;
		}
	}

	/** Prompt tokens the provider reported for the most recent request. */
	get contextTokens(): number {
		return this.contextTokensUsed;
	}

	/**
	 * Seeds the window from the model catalog on `/model`, so `/context` is
	 * right immediately instead of waiting for the first turn to report one.
	 * A later provider-reported limit overwrites it.
	 */
	setContextLimit(limit: number | null): void {
		this.contextLimitReported = limit && limit > 0 ? limit : null;
	}

	/** Window size the backend reported, when it reports one (Backboard does). */
	get reportedContextLimit(): number | null {
		return this.contextLimitReported;
	}

	/** Cached prompt tokens on the most recent request. */
	get cachedTokens(): number {
		return this.lastCachedTokens;
	}

	get usage(): Readonly<typeof this.usageTotals> {
		return this.usageTotals;
	}
}
