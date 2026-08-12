export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
	id: string;
	name: string;
	input: unknown;
}

export interface ToolResultRecord {
	toolCallId: string;
	name: string;
	output: unknown;
	isError: boolean;
}

export interface UserMessage {
	role: "user";
	text: string;
	ts: string;
}

export interface AssistantMessage {
	role: "assistant";
	text: string;
	toolCalls: ToolCall[];
	ts: string;
}

export interface ToolMessage {
	role: "tool";
	results: ToolResultRecord[];
	ts: string;
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export function userMessage(text: string): UserMessage {
	return { role: "user", text, ts: new Date().toISOString() };
}

export function assistantMessage(
	text: string,
	toolCalls: ToolCall[] = [],
): AssistantMessage {
	return { role: "assistant", text, toolCalls, ts: new Date().toISOString() };
}

export function toolMessage(results: ToolResultRecord[]): ToolMessage {
	return { role: "tool", results, ts: new Date().toISOString() };
}
