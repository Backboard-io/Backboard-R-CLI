import { describe, expect, it } from "bun:test";
import {
	formatMcpPromptForUser,
	formatMcpResourceForUser,
} from "../src/core/mcp/MCPPrimitiveFormat.ts";

describe("formatMcpPromptForUser", () => {
	it("includes server name, description, and each message", () => {
		const out = formatMcpPromptForUser("alpha", {
			description: "do the thing",
			messages: [{ role: "user", content: { type: "text", text: "hello" } }],
		} as never);
		expect(out).toContain("Use this MCP prompt from alpha");
		expect(out).toContain("Description: do the thing");
		expect(out).toContain("[user]");
		expect(out).toContain("hello");
	});

	it("omits the description line when absent", () => {
		const out = formatMcpPromptForUser("beta", {
			messages: [{ role: "assistant", content: { type: "text", text: "yo" } }],
		} as never);
		expect(out).not.toContain("Description:");
		expect(out).toContain("[assistant]");
		expect(out).toContain("yo");
	});
});

describe("formatMcpResourceForUser", () => {
	it("renders a text resource content", () => {
		const out = formatMcpResourceForUser("alpha", [
			{
				type: "text",
				uri: "file://a",
				text: "contents",
				mimeType: "text/plain",
			},
		] as never);
		expect(out).toContain("Use this MCP resource content from alpha");
		expect(out).toContain("Resource file://a (text/plain)");
		expect(out).toContain("contents");
	});

	it("summarizes a binary resource without inlining the blob", () => {
		const out = formatMcpResourceForUser("alpha", [
			{ type: "blob", uri: "file://b", blob: "YWJj", mimeType: "image/png" },
		] as never);
		expect(out).toContain("Resource file://b (image/png)");
		expect(out).toContain("[4 base64 characters]");
	});

	it("falls back to JSON for unknown content", () => {
		const out = formatMcpResourceForUser("alpha", [
			{ type: "unknown", foo: 1 },
		] as never);
		expect(out).toContain('"type": "unknown"');
		expect(out).toContain('"foo": 1');
	});
});
