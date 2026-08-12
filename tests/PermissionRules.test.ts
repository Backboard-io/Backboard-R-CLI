import { describe, expect, it } from "bun:test";
import {
	emptyRuleSet,
	findMatch,
	parseRule,
	parseRuleSet,
} from "../src/core/permissions/PermissionRules.ts";

describe("parseRule", () => {
	it("parses a bare tool rule", () => {
		expect(parseRule("execute", "allow")).toEqual({
			behavior: "allow",
			toolName: "execute",
			raw: "execute",
		});
	});

	it("parses a tool rule with content pattern", () => {
		expect(parseRule("execute(bun test:*)", "allow")).toEqual({
			behavior: "allow",
			toolName: "execute",
			pattern: "bun test:*",
			raw: "execute(bun test:*)",
		});
	});

	it("rejects malformed rules", () => {
		expect(parseRule("", "allow")).toBeNull();
		expect(parseRule("execute(unclosed", "allow")).toBeNull();
	});
});

describe("findMatch", () => {
	const rules = parseRuleSet({
		allow: ["execute(bun test:*)", "write(src/**)", "read"],
		deny: ["execute(git push:*)"],
	});

	it("matches command prefixes case-insensitively on tool name", () => {
		expect(
			findMatch(rules.allow, "Execute", "bun test --watch"),
		).not.toBeNull();
		expect(findMatch(rules.allow, "execute", "bun run build")).toBeNull();
	});

	it("matches exact content when pattern has no :* or glob", () => {
		const exact = parseRuleSet({ allow: ["execute(make)"] });
		expect(findMatch(exact.allow, "execute", "make")).not.toBeNull();
		expect(findMatch(exact.allow, "execute", "make clean")).toBeNull();
	});

	it("matches path globs", () => {
		expect(
			findMatch(rules.allow, "write", "src/core/tools/Tool.ts"),
		).not.toBeNull();
		expect(findMatch(rules.allow, "write", "package.json")).toBeNull();
	});

	it("matches bare tool rules regardless of content", () => {
		expect(findMatch(rules.allow, "read", "anything")).not.toBeNull();
		expect(findMatch(rules.allow, "read", undefined)).not.toBeNull();
	});

	it("does not match a patterned rule when content is undefined", () => {
		expect(findMatch(rules.deny, "execute", undefined)).toBeNull();
	});

	it("empty rule set matches nothing", () => {
		expect(findMatch(emptyRuleSet().allow, "execute", "ls")).toBeNull();
	});
});
