import { describe, expect, it } from "bun:test";
import type { TodoItem } from "../src/core/bus/events.ts";
import {
	formatTodoReadback,
	TodoWriteTool,
} from "../src/tools/TodoWriteTool.tsx";
import { makeContext } from "./helpers.ts";

describe("TodoWriteTool", () => {
	it("preserves omitted step budgets and accepts explicit reallocations", async () => {
		const previous: TodoItem[] = [
			{
				id: "a",
				content: "Plan",
				status: "in_progress",
				timeBudgetSeconds: 120,
			},
			{ id: "b", content: "Build", status: "pending", timeBudgetSeconds: 300 },
		];
		const ctx = makeContext(new AbortController().signal);
		ctx.getTodos = () => previous;
		let actual: TodoItem[] = [];
		ctx.bus.on("todos:updated", (event) => {
			actual = event.todos;
		});
		const tool = new TodoWriteTool();
		await tool.execute(
			tool.parseInput({
				todos: [
					{ content: "Plan", status: "completed" },
					{ content: "Build", status: "pending", timeBudgetSeconds: 240 },
				],
			}),
			ctx,
		);
		expect(actual).toEqual([
			{ id: "a", content: "Plan", status: "completed", timeBudgetSeconds: 120 },
			{
				id: "b",
				content: "Build",
				status: "in_progress",
				timeBudgetSeconds: 240,
			},
		]);
	});

	it("rejects invalid optional step budgets", () => {
		const tool = new TodoWriteTool();
		for (const timeBudgetSeconds of [0, -1, 0.5, Infinity, Number.MAX_VALUE]) {
			expect(() =>
				tool.parseInput({
					todos: [
						{ content: "Plan", status: "in_progress", timeBudgetSeconds },
					],
				}),
			).toThrow();
		}
	});

	it("trims content and preserves ids for unchanged todos", async () => {
		const previousTodos: TodoItem[] = [
			{ id: "todo_existing", content: "Plan work", status: "pending" },
		];
		const tool = new TodoWriteTool();
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.getTodos = () => previousTodos;
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [
				{ content: " Plan work ", status: "in_progress" },
				{ content: "Write tests", status: "pending" },
			],
		});
		const result = await tool.execute(input, ctx);

		expect(result.data.count).toBe(2);
		expect(emittedTodos[0]).toEqual({
			id: "todo_existing",
			content: "Plan work",
			status: "in_progress",
		});
		expect(emittedTodos[1]).toMatchObject({
			content: "Write tests",
			status: "pending",
		});
		expect(emittedTodos[1]?.id).toMatch(/^todo_/);
		expect(result.forLLM).toBe(
			"Updated 2 todos: [in_progress] Plan work, [pending] Write tests",
		);
	});

	it("reads each todo back with its status for steering", () => {
		expect(
			formatTodoReadback([
				{ id: "todo_1", content: "write tests", status: "completed" },
				{ id: "todo_2", content: "run validation", status: "in_progress" },
			]),
		).toBe(
			"Updated 2 todos: [completed] write tests, [in_progress] run validation",
		);
		expect(formatTodoReadback([])).toBe("Updated 0 todos");
	});

	it("rejects blank todo content", () => {
		const tool = new TodoWriteTool();

		expect(() =>
			tool.parseInput({
				todos: [{ content: "   ", status: "pending" }],
			}),
		).toThrow();
	});

	it("keeps only the first in-progress todo", async () => {
		const tool = new TodoWriteTool();
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [
				{ content: "One", status: "in_progress" },
				{ content: "Two", status: "in_progress" },
			],
		});
		await tool.execute(input, ctx);

		expect(
			emittedTodos.map(({ content, status }) => ({ content, status })),
		).toEqual([
			{ content: "One", status: "in_progress" },
			{ content: "Two", status: "pending" },
		]);
	});

	it("promotes the first pending todo when none is in progress", async () => {
		const tool = new TodoWriteTool();
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [
				{ content: "One", status: "pending" },
				{ content: "Two", status: "pending" },
			],
		});
		await tool.execute(input, ctx);

		expect(
			emittedTodos.map(({ content, status }) => ({ content, status })),
		).toEqual([
			{ content: "One", status: "in_progress" },
			{ content: "Two", status: "pending" },
		]);
	});

	it("keeps a newly introduced completed todo active", async () => {
		const tool = new TodoWriteTool();
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [{ content: "Count to 5", status: "completed" }],
		});
		await tool.execute(input, ctx);

		expect(emittedTodos).toMatchObject([
			{ content: "Count to 5", status: "in_progress" },
		]);
	});

	it("allows an existing todo to transition to completed", async () => {
		const tool = new TodoWriteTool();
		const previousTodos: TodoItem[] = [
			{ id: "todo_existing", content: "Count to 5", status: "in_progress" },
		];
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.getTodos = () => previousTodos;
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [{ content: "Count to 5", status: "completed" }],
		});
		await tool.execute(input, ctx);

		expect(emittedTodos).toEqual([
			{ id: "todo_existing", content: "Count to 5", status: "completed" },
		]);
	});

	it("allows completion of a todo introduced earlier in the same turn", async () => {
		const tool = new TodoWriteTool();
		const currentTodos: TodoItem[] = [
			{ id: "todo_new", content: "Count to 5", status: "in_progress" },
		];
		let emittedTodos: TodoItem[] = [];
		const ctx = makeContext(new AbortController().signal);
		ctx.getTodos = () => currentTodos;
		ctx.bus.on("todos:updated", (event) => {
			emittedTodos = event.todos;
		});

		const input = tool.parseInput({
			todos: [{ content: "Count to 5", status: "completed" }],
		});
		await tool.execute(input, ctx);

		expect(emittedTodos).toEqual([
			{ id: "todo_new", content: "Count to 5", status: "completed" },
		]);
	});
});
