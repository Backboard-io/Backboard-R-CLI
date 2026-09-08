import type { TodoItem } from "../../bus/events.ts";

export interface TimedTodoUpdate {
	todos: readonly TodoItem[];
	at: number;
}
