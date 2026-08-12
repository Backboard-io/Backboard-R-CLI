import type { TodoItem } from "../bus/events.ts";

export interface TodoDraft {
	content: string;
	status: TodoItem["status"];
}
