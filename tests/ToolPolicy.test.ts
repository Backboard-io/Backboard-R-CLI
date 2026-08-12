import { describe, expect, it } from "bun:test";
import {
	ToolPolicy,
	type ToolPolicySnapshot,
} from "../src/core/tools/ToolPolicy.ts";

function snapshot(
	overrides: Partial<ToolPolicySnapshot> = {},
): ToolPolicySnapshot {
	return {
		profileTools: [],
		modelTools: [],
		excludedTools: [],
		computerUseEnabled: true,
		browserUseEnabled: true,
		skillDiscoveryEnabled: true,
		...overrides,
	};
}

describe("ToolPolicy skill-discovery gate", () => {
	it("blocks find_skill/find_mcp when discovery is disabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		expect(policy.isRuntimeAllowed("find_skill")).toBe(false);
		expect(policy.isRuntimeAllowed("find_mcp")).toBe(false);
	});

	it("also blocks by display name", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		expect(policy.isRuntimeAllowed("FindSkill")).toBe(false);
		expect(policy.isRuntimeAllowed("FindMcp")).toBe(false);
	});

	it("excludes the discovery tools from schemas when disabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: false }));
		const excluded = policy.schemaExcludedNames();
		expect(excluded).toContain("find_skill");
		expect(excluded).toContain("find_mcp");
	});

	it("allows find_skill/find_mcp when discovery is enabled", () => {
		const policy = new ToolPolicy(snapshot({ skillDiscoveryEnabled: true }));
		expect(policy.isRuntimeAllowed("find_skill")).toBe(true);
		expect(policy.isRuntimeAllowed("find_mcp")).toBe(true);
		const excluded = policy.schemaExcludedNames();
		expect(excluded).not.toContain("find_skill");
		expect(excluded).not.toContain("find_mcp");
	});
});
