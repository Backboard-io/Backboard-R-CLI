import { describe, expect, it } from "bun:test";
import { FetchUrlTool } from "../src/tools/FetchUrlTool.tsx";
import { WebSearchTool } from "../src/tools/WebSearchTool.tsx";

const auto = { mode: "auto" as const, cwd: "/project", interactive: true };
const manual = { mode: "manual" as const, cwd: "/project", interactive: true };

describe("FetchUrlTool permissions", () => {
	const tool = new FetchUrlTool();

	it("allows fetches in auto", () => {
		expect(tool.checkPermissions({ url: "https://example.com" }, auto)).toEqual(
			{ behavior: "allow", reason: "network read (auto mode)" },
		);
	});

	it("has no opinion in manual mode", () => {
		expect(
			tool.checkPermissions({ url: "https://example.com" }, manual),
		).toBeUndefined();
	});

	it("exposes the url as permission content so deny rules can match", () => {
		expect(tool.permissionContent({ url: "https://example.com/x" })).toBe(
			"https://example.com/x",
		);
	});
});

describe("WebSearchTool permissions", () => {
	const tool = new WebSearchTool();

	it("allows searches in auto", () => {
		expect(tool.checkPermissions({ query: "bun test" }, auto)).toEqual({
			behavior: "allow",
			reason: "network read (auto mode)",
		});
	});

	it("has no opinion in manual mode", () => {
		expect(
			tool.checkPermissions({ query: "bun test" }, manual),
		).toBeUndefined();
	});

	it("exposes the query as permission content so deny rules can match", () => {
		expect(tool.permissionContent({ query: "secret plans" })).toBe(
			"secret plans",
		);
	});
});
