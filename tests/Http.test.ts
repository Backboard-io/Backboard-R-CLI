import { describe, expect, it } from "bun:test";
import { readLimitedResponseText } from "../src/utils/http.ts";

describe("HTTP helpers", () => {
	it("reads response text under the byte limit", async () => {
		const result = await readLimitedResponseText(new Response("hello"), 10);

		expect(result).toEqual({ text: "hello", truncated: false });
	});

	it("stops reading once the byte limit is reached", async () => {
		const result = await readLimitedResponseText(new Response("abcdef"), 3);

		expect(result).toEqual({ text: "abc", truncated: true });
	});

	it("does not emit partial multibyte characters when truncating", async () => {
		const result = await readLimitedResponseText(new Response("a🙂b"), 3);

		expect(result.text).toBe("a");
		expect(result.truncated).toBe(true);
	});
});
