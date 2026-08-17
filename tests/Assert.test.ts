import { describe, expect, it } from "bun:test";
import { assert, assertNever } from "../src/utils/assert.ts";

describe("assert", () => {
	it("does not throw when the condition is truthy", () => {
		expect(() => assert(true, "x")).not.toThrow();
		expect(() => assert(1, "x")).not.toThrow();
	});

	it("throws with a prefixed message when the condition is falsy", () => {
		expect(() => assert(false, "boom")).toThrow("Assertion failed: boom");
		expect(() => assert(0, "zero")).toThrow("Assertion failed: zero");
		expect(() => assert(undefined, "nope")).toThrow("Assertion failed: nope");
	});
});

describe("assertNever", () => {
	it("throws the provided message", () => {
		expect(() => assertNever("x" as never, "unexpected x")).toThrow(
			"unexpected x",
		);
	});

	it("fallbacks to a JSON-serialized message when none is given", () => {
		expect(() => assertNever("x" as never)).toThrow('Unexpected value: "x"');
		expect(() => assertNever({ a: 1 } as never)).toThrow(
			'Unexpected value: {"a":1}',
		);
	});
});
