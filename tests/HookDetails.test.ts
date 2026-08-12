import { describe, expect, it } from "bun:test";
import { resolveHookDetailsAction } from "../src/ui/components/HookDetails.tsx";

const keys = { escape: false, return: false };
const idle = { confirmingDelete: false, deleting: false, canDelete: true };

describe("HookDetails key routing", () => {
	it("starts delete confirmation on d", () => {
		expect(resolveHookDetailsAction("d", keys, idle)).toEqual({
			type: "confirm-delete",
		});
		expect(resolveHookDetailsAction("D", keys, idle)).toEqual({
			type: "confirm-delete",
		});
	});

	it("ignores d when deletion is unavailable", () => {
		expect(
			resolveHookDetailsAction("d", keys, { ...idle, canDelete: false }),
		).toEqual({ type: "none" });
	});

	it("deletes on y while confirming", () => {
		const confirming = { ...idle, confirmingDelete: true };
		expect(resolveHookDetailsAction("y", keys, confirming)).toEqual({
			type: "delete",
		});
	});

	it("cancels confirmation on n or escape", () => {
		const confirming = { ...idle, confirmingDelete: true };
		expect(resolveHookDetailsAction("n", keys, confirming)).toEqual({
			type: "cancel-confirm",
		});
		expect(
			resolveHookDetailsAction("", { ...keys, escape: true }, confirming),
		).toEqual({ type: "cancel-confirm" });
		expect(resolveHookDetailsAction("x", keys, confirming)).toEqual({
			type: "none",
		});
	});

	it("goes back on escape or enter outside confirmation", () => {
		expect(
			resolveHookDetailsAction("", { ...keys, escape: true }, idle),
		).toEqual({ type: "back" });
		expect(
			resolveHookDetailsAction("", { ...keys, return: true }, idle),
		).toEqual({ type: "back" });
	});

	it("ignores all input while a delete is in flight", () => {
		const deleting = { ...idle, confirmingDelete: true, deleting: true };
		expect(resolveHookDetailsAction("y", keys, deleting)).toEqual({
			type: "none",
		});
		expect(
			resolveHookDetailsAction("", { ...keys, escape: true }, deleting),
		).toEqual({ type: "none" });
	});
});
