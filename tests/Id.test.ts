import { describe, expect, it } from "bun:test";
import { nextSequence, shortId, uuid } from "../src/utils/id.ts";

describe("id utils", () => {
	it("uuid returns a valid 36-char v4 string", () => {
		const id = uuid();
		expect(id).toHaveLength(36);
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
	});

	it("uuid returns unique values", () => {
		expect(uuid()).not.toBe(uuid());
	});

	it("shortId returns an 8-char hex string with no prefix", () => {
		const id = shortId();
		expect(id).toHaveLength(8);
		expect(id).toMatch(/^[0-9a-f]{8}$/i);
	});

	it("shortId prepends the prefix with an underscore", () => {
		const id = shortId("tool");
		expect(id).toMatch(/^tool_[0-9a-f]{8}$/i);
	});

	it("shortId returns unique values", () => {
		expect(shortId()).not.toBe(shortId());
	});

	it("nextSequence increments monotonically from the prior counter state", () => {
		const first = nextSequence();
		const second = nextSequence();
		expect(second).toBe(first + 1);
	});
});
