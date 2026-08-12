import { describe, expect, it } from "bun:test";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { assistantMessage, userMessage } from "../src/core/session/Message.ts";
import { Session } from "../src/core/session/Session.ts";

describe("Session", () => {
	it("tracks todos from bus events and clears completed todos on next turn", () => {
		const bus = new EventBus();
		const session = new Session("sess_test");
		const detach = session.attach(bus);

		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "completed" }],
		});
		expect(session.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "completed" },
		]);

		bus.emit({ type: "turn:start", turnId: "turn_2" });
		expect(session.todos).toEqual([]);

		detach();
	});

	it("keeps unfinished todos when the next turn starts", () => {
		const bus = new EventBus();
		const session = new Session("sess_test");
		const detach = session.attach(bus);

		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "pending" }],
		});
		bus.emit({ type: "turn:start", turnId: "turn_2" });

		expect(session.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "pending" },
		]);

		detach();
	});

	it("tracks whether TodoWrite has been used this session", () => {
		const bus = new EventBus();
		const session = new Session("sess_test");
		const detach = session.attach(bus);

		expect(session.hasUsedTodoWrite).toBe(false);
		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_1", content: "Plan work", status: "pending" }],
		});
		expect(session.hasUsedTodoWrite).toBe(true);

		session.reset();
		expect(session.hasUsedTodoWrite).toBe(false);

		bus.emit({
			type: "todos:updated",
			todos: [{ id: "todo_2", content: "More work", status: "pending" }],
		});
		expect(session.hasUsedTodoWrite).toBe(true);

		session.hydrate({ threadId: "thread_1", messages: [] });
		expect(session.hasUsedTodoWrite).toBe(false);

		detach();
	});

	it("derives TodoWrite usage from the hydrated transcript", () => {
		const session = new Session("sess_test");
		session.hydrate({
			threadId: "thread_1",
			messages: [
				userMessage("build it"),
				assistantMessage("on it", [
					{ id: "call_1", name: "todo_write", input: {} },
				]),
			],
		});
		expect(session.hasUsedTodoWrite).toBe(true);

		session.hydrate({
			threadId: "thread_2",
			messages: [
				userMessage("hi"),
				assistantMessage("hello", [
					{ id: "call_1", name: "execute", input: {} },
				]),
			],
		});
		expect(session.hasUsedTodoWrite).toBe(false);
	});

	it("restores todos from the last TodoWrite call on hydrate", () => {
		const session = new Session("sess_test");
		session.hydrate({
			threadId: "thread_1",
			messages: [
				assistantMessage("planning", [
					{
						id: "call_1",
						name: "todo_write",
						input: { todos: [{ content: "Old item", status: "completed" }] },
					},
				]),
				assistantMessage("update", [
					{
						id: "call_2",
						name: "todo_write",
						input: {
							todos: [
								{ content: "Ship fix", status: "completed" },
								{ content: "Write docs", status: "in_progress" },
							],
						},
					},
				]),
			],
		});
		expect(
			session.todos.map((todo) => ({
				content: todo.content,
				status: todo.status,
			})),
		).toEqual([
			{ content: "Ship fix", status: "completed" },
			{ content: "Write docs", status: "in_progress" },
		]);
	});

	it("hydrates an empty todo list when the last TodoWrite is fully complete", () => {
		const session = new Session("sess_test");
		session.hydrate({
			threadId: "thread_1",
			messages: [
				assistantMessage("done", [
					{
						id: "call_1",
						name: "todo_write",
						input: {
							todos: [
								{ content: "Ship fix", status: "completed" },
								{ content: "Write docs", status: "completed" },
							],
						},
					},
				]),
			],
		});
		expect(session.todos).toEqual([]);
	});

	it("ignores malformed TodoWrite input on hydrate", () => {
		const session = new Session("sess_test");
		session.hydrate({
			threadId: "thread_1",
			messages: [
				assistantMessage("odd", [
					{ id: "call_1", name: "todo_write", input: { todos: "nope" } },
				]),
			],
		});
		expect(session.todos).toEqual([]);
	});

	it("clears a stale provider context limit when hydrating another thread", () => {
		const session = new Session("sess_test");
		session.setContextLimit(1_048_576);

		session.hydrate({ threadId: "thread_1", messages: [] });

		expect(session.reportedContextLimit).toBeNull();
	});
});
