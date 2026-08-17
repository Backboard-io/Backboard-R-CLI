import { describe, expect, it } from "bun:test";
import type { AgentDefinition } from "../src/core/agents/AgentDefinition.ts";
import type { Tool } from "../src/core/tools/Tool.ts";
import { selectDelegatableTools } from "../src/tools/delegatableTools.ts";
import { TestTool } from "./helpers.ts";

const AGENT_TOOL = new TestTool({ name: "Agent", readOnly: false });

function candidates(): Tool[] {
	return [
		new TestTool({ name: "Read", readOnly: true }),
		new TestTool({ name: "Grep", readOnly: true }),
		new TestTool({ name: "Write", readOnly: false }),
		new TestTool({ name: "AskUser", readOnly: true }),
		new TestTool({ name: "Browser", readOnly: true }),
		AGENT_TOOL,
	];
}

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "a",
		description: "d",
		mode: "worker",
		systemPrompt: "p",
		source: "project",
		...overrides,
	};
}

function select(
	def: AgentDefinition,
	isToolEnabled: (name: string) => boolean = () => true,
): string[] {
	return selectDelegatableTools({
		definition: def,
		candidates: candidates(),
		agentTool: AGENT_TOOL,
		isToolEnabled,
	}).map((tool) => tool.agentName);
}

describe("selectDelegatableTools", () => {
	it("drops non-delegatable tools and keeps the rest", () => {
		const names = select(definition());
		expect(names).not.toContain("ask_user");
		expect(names).not.toContain("browser");
		expect(names).toEqual(
			expect.arrayContaining(["read", "grep", "write", "agent"]),
		);
	});

	it("restricts to the definition's tools allowlist", () => {
		expect(select(definition({ tools: ["read", "grep"] }))).toEqual([
			"read",
			"grep",
		]);
	});

	it("removes disallowed tools", () => {
		const names = select(definition({ disallowedTools: ["write"] }));
		expect(names).toContain("read");
		expect(names).not.toContain("write");
	});

	it("omits nested delegation unless the allowlist names the agent tool", () => {
		expect(select(definition({ tools: ["read"] }))).not.toContain("agent");
		expect(select(definition({ tools: ["read", "agent"] }))).toContain("agent");
	});

	it("omits nested delegation when the agent tool is disallowed or disabled", () => {
		expect(select(definition({ disallowedTools: ["agent"] }))).not.toContain(
			"agent",
		);
		expect(select(definition(), (name) => name !== "agent")).not.toContain(
			"agent",
		);
	});

	it("never lists the agent tool twice", () => {
		const names = select(definition());
		expect(names.filter((name) => name === "agent")).toHaveLength(1);
	});
});
