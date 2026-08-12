import { describe, expect, it } from "bun:test";
import type { AssistantAccumulator } from "../src/core/agent/AssistantAccumulator.ts";
import {
	FINAL_VERIFICATION_MIN_TOOL_CALLS,
	finalVerificationNotification,
} from "../src/core/agent/notifications/FinalVerificationNotification.ts";
import type {
	SystemNotification,
	SystemNotificationContext,
} from "../src/core/agent/notifications/SystemNotification.ts";
import {
	SystemNotificationRunner,
	type SystemNotificationRunnerDeps,
} from "../src/core/agent/notifications/SystemNotificationRunner.ts";
import { todoReconciliationNotification } from "../src/core/agent/notifications/TodoReconciliationNotification.ts";
import type { TodoItem } from "../src/core/bus/events.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { FINAL_VERIFICATION_NUDGE } from "../src/prompts/finalVerification.ts";
import { PLAN_UP_TO_DATE_REPLY } from "../src/prompts/todoReminders.ts";

function notification(
	overrides: Partial<SystemNotification> & { id: string },
): SystemNotification {
	return {
		supersedesFinalAnswer: false,
		hidesResponse: false,
		shouldFire: () => true,
		content: () => `content:${overrides.id}`,
		...overrides,
	};
}

/**
 * Builds a runner over stubbed consumer/processor deps. Each processed
 * notification advances the fake counters by one round and callsPerProcess
 * calls, mirroring how ToolRoundProcessor's counters move between injections.
 */
function makeRunner(
	notifications: SystemNotification[],
	options: {
		rounds?: number;
		calls?: number;
		callsPerProcess?: number;
		todos?: readonly { id: string; content: string; status: string }[];
		tools?: readonly { function: { name: string } }[];
		refreshSystemPrompt?: () => string;
		/** Notification ids whose runMessage should throw. */
		failFor?: readonly string[];
		/** Called at the start of each injected notification's consume. */
		probe?: () => void;
	} = {},
) {
	const counters = {
		executedRounds: options.rounds ?? 1,
		executedToolCalls: options.calls ?? 20,
	};
	const sent: string[] = [];
	const requests: Record<string, unknown>[] = [];
	const deps = {
		client: {
			runMessage: (request: Record<string, unknown> & { content: string }) => {
				if (
					options.failFor?.some((id) => request.content === `content:${id}`)
				) {
					throw new Error(`provider rejected ${request.content}`);
				}
				sent.push(request.content);
				requests.push(request);
				return { kind: "fake-stream" };
			},
		},
		consumer: {
			consumeWithRetry: async (create: () => unknown) => {
				options.probe?.();
				return create();
			},
		},
		processor: {
			get executedRounds() {
				return counters.executedRounds;
			},
			get executedToolCalls() {
				return counters.executedToolCalls;
			},
			createEarlyRound: () => ({}),
			process: async () => {
				counters.executedRounds += 1;
				counters.executedToolCalls += options.callsPerProcess ?? 1;
			},
		},
		session: { threadId: "thread_1", todos: options.todos ?? [] },
		tools: options.tools ?? [],
		systemPrompt: "system prompt",
		refreshSystemPrompt: options.refreshSystemPrompt,
		model: { provider: "openai", model: "gpt-test" },
		memory: "off",
		memoryProfile: "default",
		requestKind: "user",
	} as unknown as SystemNotificationRunnerDeps;
	const runner = new SystemNotificationRunner(deps, notifications);
	const ctx = { signal: new AbortController().signal } as ToolContext;
	const assistant = {
		discardPartial: () => {},
	} as unknown as AssistantAccumulator;
	return {
		runner,
		sent,
		requests,
		counters,
		run: () => runner.runPending("turn_1", assistant, ctx),
	};
}

describe("SystemNotificationRunner", () => {
	it("reports a superseding final answer only when a superseding notification would fire", () => {
		const firing = makeRunner([
			notification({ id: "a", supersedesFinalAnswer: true }),
		]);
		expect(firing.runner.willSupersedeFinalAnswer()).toBe(true);

		const notFiring = makeRunner([
			notification({
				id: "a",
				supersedesFinalAnswer: true,
				shouldFire: () => false,
			}),
		]);
		expect(notFiring.runner.willSupersedeFinalAnswer()).toBe(false);

		const nonSuperseding = makeRunner([notification({ id: "a" })]);
		expect(nonSuperseding.runner.willSupersedeFinalAnswer()).toBe(false);
	});

	it("evaluates willSupersedeFinalAnswer against the live processor counters", () => {
		const { runner, counters } = makeRunner(
			[
				notification({
					id: "a",
					supersedesFinalAnswer: true,
					shouldFire: (context) => context.executedToolCalls >= 25,
				}),
			],
			{ calls: 20 },
		);
		expect(runner.willSupersedeFinalAnswer()).toBe(false);
		counters.executedToolCalls = 25;
		expect(runner.willSupersedeFinalAnswer()).toBe(true);
	});

	it("fires notifications in order and skips non-firing ones without stopping", async () => {
		const { sent, run } = makeRunner([
			notification({ id: "a" }),
			notification({ id: "skipped", shouldFire: () => false }),
			notification({ id: "b" }),
		]);
		await run();
		expect(sent).toEqual(["content:a", "content:b"]);
	});

	it("freezes gating counts so an earlier notification's tool calls can't fire a later one", async () => {
		// The double-summary bug: the main turn ended at 16 tool calls (below a
		// 17 threshold), so the final answer was shown unbuffered. The first
		// notification then injects tool calls, pushing the LIVE counter past
		// 17 - but the second must still see the frozen main-turn count and NOT
		// fire, or the user gets a second summary.
		const seen: number[] = [];
		const { sent, run } = makeRunner(
			[
				notification({ id: "reconcile" }),
				notification({
					id: "verify",
					shouldFire: (context) => {
						seen.push(context.executedToolCalls);
						return context.executedToolCalls >= 17;
					},
				}),
			],
			{ calls: 16, callsPerProcess: 5 },
		);
		await run();
		expect(seen).toEqual([16]); // frozen main-turn count, not 21
		expect(sent).toEqual(["content:reconcile"]);
	});

	it("loops a repeatable notification until it stops wanting to fire", async () => {
		// Emulates the todo reminder closing items pass by pass (live state,
		// not the frozen counts), then stopping once none remain.
		let open = 4;
		const { sent, run } = makeRunner([
			notification({
				id: "todo",
				maxRepeats: 5,
				shouldFire: () => open > 0,
				content: () => {
					const current = open;
					open -= 1;
					return `open:${current}`;
				},
			}),
		]);
		await run();
		expect(sent).toEqual(["open:4", "open:3", "open:2", "open:1"]);
	});

	it("stops repeating when a pass produces no change (stall break)", async () => {
		const { sent, run } = makeRunner([
			notification({ id: "todo", maxRepeats: 5, content: () => "unchanged" }),
		]);
		await run();
		expect(sent).toEqual(["unchanged"]);
	});

	it("caps repeats at maxRepeats when the state keeps changing", async () => {
		let n = 0;
		const { sent, run } = makeRunner([
			notification({
				id: "todo",
				maxRepeats: 3,
				content: () => `c:${n++}`,
			}),
		]);
		await run();
		expect(sent).toEqual(["c:0", "c:1", "c:2"]);
	});

	it("reports hidden responses only while a hidesResponse notification is injecting", async () => {
		const seen: boolean[] = [];
		let runnerRef: SystemNotificationRunner | undefined;
		const made = makeRunner(
			[
				notification({ id: "hidden", hidesResponse: true }),
				notification({ id: "visible" }),
			],
			{
				probe: () => {
					seen.push(runnerRef?.activeNotificationHidesResponse() ?? false);
				},
			},
		);
		runnerRef = made.runner;
		await made.run();

		expect(seen).toEqual([true, false]);
		expect(made.runner.activeNotificationHidesResponse()).toBe(false);
	});

	it("exposes the session todos to shouldFire and content", async () => {
		const seen: SystemNotificationContext[] = [];
		const { run } = makeRunner(
			[
				notification({
					id: "a",
					shouldFire: (context) => {
						seen.push(context);
						return false;
					},
				}),
			],
			{
				todos: [{ id: "todo_1", content: "Plan work", status: "pending" }],
			},
		);
		await run();

		expect(seen[0]?.todos).toEqual([
			{ id: "todo_1", content: "Plan work", status: "pending" },
		]);
	});

	it("swallows failures from best-effort notifications and keeps going", async () => {
		const { sent, run } = makeRunner(
			[notification({ id: "flaky" }), notification({ id: "b" })],
			{ failFor: ["flaky"] },
		);
		await run();
		expect(sent).toEqual(["content:b"]);
	});

	it("propagates failures from notifications that supersede the final answer", async () => {
		const { run } = makeRunner(
			[notification({ id: "flaky", supersedesFinalAnswer: true })],
			{ failFor: ["flaky"] },
		);
		await expect(run()).rejects.toThrow("provider rejected content:flaky");
	});

	it("applies per-notification tool restriction and thinking override", async () => {
		const { requests, run } = makeRunner(
			[
				notification({
					id: "restricted",
					thinking: null,
					restrictTools: (tools) =>
						tools.filter((tool) => tool.function.name === "todo_write"),
				}),
				notification({ id: "unrestricted" }),
			],
			{
				tools: [
					{ function: { name: "todo_write" } },
					{ function: { name: "execute" } },
				],
			},
		);
		await run();

		expect(requests[0]?.tools).toEqual([{ function: { name: "todo_write" } }]);
		expect(requests[0]?.thinking).toBeNull();
		expect(requests[1]?.tools).toHaveLength(2);
		expect(requests[1] && "thinking" in requests[1]).toBe(false);
	});

	it("refreshes the system prompt for injected requests", async () => {
		const { requests, run } = makeRunner([notification({ id: "a" })], {
			refreshSystemPrompt: () => "fresh prompt",
		});
		await run();
		expect(requests[0]?.system_prompt).toBe("fresh prompt");
	});

	it("tags injected requests with the notification id so they can be pruned/filtered", async () => {
		const { requests, run } = makeRunner([
			notification({ id: "todo-reconciliation" }),
		]);
		await run();
		expect(
			(requests[0]?.metadata as Record<string, unknown> | undefined)
				?.injected_notification,
		).toBe("todo-reconciliation");
	});

	it("passes each notification's content through the run-message request", async () => {
		const seen: SystemNotificationContext[] = [];
		const { sent, run } = makeRunner(
			[
				notification({
					id: "a",
					content: (context) => {
						seen.push(context);
						return `calls:${context.executedToolCalls}`;
					},
				}),
			],
			{ calls: 42 },
		);
		await run();
		expect(sent).toEqual(["calls:42"]);
		expect(seen[0]?.requestKind).toBe("user");
	});
});

describe("finalVerificationNotification", () => {
	const context = (
		overrides: Partial<SystemNotificationContext> = {},
	): SystemNotificationContext => ({
		requestKind: "user",
		executedRounds: 1,
		executedToolCalls: FINAL_VERIFICATION_MIN_TOOL_CALLS,
		todos: [],
		...overrides,
	});

	it("supersedes the final answer with the verification nudge", () => {
		const nudge = finalVerificationNotification(true);
		expect(nudge.id).toBe("final-verification");
		expect(nudge.supersedesFinalAnswer).toBe(true);
		expect(nudge.content(context())).toBe(FINAL_VERIFICATION_NUDGE);
	});

	it("fires only for substantial enabled user turns", () => {
		expect(finalVerificationNotification(true).shouldFire(context())).toBe(
			true,
		);
		expect(finalVerificationNotification(false).shouldFire(context())).toBe(
			false,
		);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({ requestKind: "subagent" }),
			),
		).toBe(false);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({ executedRounds: 0 }),
			),
		).toBe(false);
		expect(
			finalVerificationNotification(true).shouldFire(
				context({
					executedToolCalls: FINAL_VERIFICATION_MIN_TOOL_CALLS - 1,
				}),
			),
		).toBe(false);
	});
});

describe("todoReconciliationNotification", () => {
	const openTodos: TodoItem[] = [
		{ id: "todo_1", content: "Ship feature", status: "completed" },
		{ id: "todo_2", content: "Write tests", status: "in_progress" },
		{ id: "todo_3", content: "Update docs", status: "pending" },
	];

	const context = (
		overrides: Partial<SystemNotificationContext> = {},
	): SystemNotificationContext => ({
		requestKind: "user",
		executedRounds: 1,
		executedToolCalls: 3,
		todos: openTodos,
		...overrides,
	});

	it("hides its response, does not supersede, and loops until todos close", () => {
		const reminder = todoReconciliationNotification();
		expect(reminder.id).toBe("todo-reconciliation");
		expect(reminder.supersedesFinalAnswer).toBe(false);
		expect(reminder.hidesResponse).toBe(true);
		expect(reminder.maxRepeats).toBeGreaterThan(1);
	});

	it("disables thinking and offers the full tool set so the agent can finish the work", () => {
		const reminder = todoReconciliationNotification();
		expect(reminder.thinking).toBeNull();
		// No tool restriction: an agent that stopped early should be able to
		// complete remaining work, not just record it.
		expect(reminder.restrictTools).toBeUndefined();
	});

	it("fires only for user turns that did work and left todos open", () => {
		const reminder = todoReconciliationNotification();
		expect(reminder.shouldFire(context())).toBe(true);
		expect(reminder.shouldFire(context({ requestKind: "subagent" }))).toBe(
			false,
		);
		expect(reminder.shouldFire(context({ executedToolCalls: 0 }))).toBe(false);
		expect(reminder.shouldFire(context({ todos: [] }))).toBe(false);
		expect(
			reminder.shouldFire(
				context({
					todos: [{ id: "todo_1", content: "Done", status: "completed" }],
				}),
			),
		).toBe(false);
	});

	it("lists only open items and demands a TodoWrite call or the exact sentinel", () => {
		const text = todoReconciliationNotification().content(context());
		expect(text).toContain("<system-reminder>");
		expect(text).toContain("1. [in_progress] Write tests");
		expect(text).toContain("2. [pending] Update docs");
		expect(text).not.toContain("Ship feature");
		expect(text).toContain(`reply exactly: ${PLAN_UP_TO_DATE_REPLY}`);
		expect(text).toContain(
			"Do not reference this system reminder in any user-facing messages.",
		);
	});
});
