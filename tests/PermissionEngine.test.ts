import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { decidePermission } from "../src/core/permissions/PermissionEngine.ts";
import { parseRuleSet } from "../src/core/permissions/PermissionRules.ts";
import type {
	PermissionCheckContext,
	PermissionContext,
	PermissionDecision,
} from "../src/core/permissions/types.ts";
import { Tool } from "../src/core/tools/Tool.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../src/core/tools/ToolResult.ts";
import { ApplyPatchTool } from "../src/tools/ApplyPatchTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";
import { McpToolAdapter } from "../src/tools/MCPToolAdapter.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";

const schema = z.object({ command: z.string().optional() });
type Input = z.infer<typeof schema>;

class FakeTool extends Tool<Input, null> {
	readonly name: string;
	readonly inputSchema = schema;
	private readonly readOnly: boolean;
	private readonly verdict: PermissionDecision | undefined;

	constructor(opts: {
		name: string;
		readOnly?: boolean;
		verdict?: PermissionDecision;
	}) {
		super();
		this.name = opts.name;
		this.readOnly = opts.readOnly ?? false;
		this.verdict = opts.verdict;
	}

	override isReadOnly(): boolean {
		return this.readOnly;
	}

	override checkPermissions(
		_input: Input,
		_ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		return this.verdict;
	}

	override permissionContent(input: Input): string | undefined {
		return input.command;
	}

	override async execute(
		_input: Input,
		_ctx: ToolContext,
	): Promise<ToolResult<null>> {
		return ok(null, "done", "done");
	}
}

function pctx(overrides: Partial<PermissionContext> = {}): PermissionContext {
	return {
		mode: "manual",
		rules: parseRuleSet({}),
		interactive: true,
		...overrides,
	};
}

describe("decidePermission", () => {
	it("deny rule wins over everything, even bypass", () => {
		const context = pctx({
			mode: "bypass",
			rules: parseRuleSet({ deny: ["mutate(git push:*)"], allow: ["mutate"] }),
		});
		const tool = new FakeTool({ name: "mutate" });
		const decision = decidePermission(
			tool,
			{ command: "git push origin main" },
			context,
			"/tmp",
		);
		expect(decision.behavior).toBe("deny");
	});

	it("ask rule forces ask, even in bypass", () => {
		const context = pctx({
			mode: "bypass",
			rules: parseRuleSet({ ask: ["mutate(npm publish:*)"] }),
		});
		const tool = new FakeTool({ name: "mutate" });
		const decision = decidePermission(
			tool,
			{ command: "npm publish" },
			context,
			"/tmp",
		);
		expect(decision.behavior).toBe("ask");
	});

	it("tool allow verdict short-circuits (safe command shape)", () => {
		const tool = new FakeTool({
			name: "mutate",
			verdict: { behavior: "allow", reason: "safe" },
		});
		const decision = decidePermission(tool, { command: "ls" }, pctx(), "/tmp");
		expect(decision).toEqual({ behavior: "allow", reason: "safe" });
	});

	it("tool deny verdict short-circuits", () => {
		const tool = new FakeTool({
			name: "mutate",
			verdict: { behavior: "deny", reason: "blocked by tool" },
		});
		const decision = decidePermission(
			tool,
			{},
			pctx({ mode: "bypass" }),
			"/tmp",
		);
		// Tool verdicts run before the bypass gate.
		expect(decision.behavior).toBe("deny");
	});

	it("read-only tools are allowed in the permissive modes", () => {
		const tool = new FakeTool({ name: "lookup", readOnly: true });
		for (const mode of ["acceptEdits", "auto", "bypass"] as const) {
			expect(decidePermission(tool, {}, pctx({ mode }), "/tmp").behavior).toBe(
				"allow",
			);
		}
	});

	it("manual asks for read-only tools when a human can answer", () => {
		const tool = new FakeTool({ name: "lookup", readOnly: true });
		expect(decidePermission(tool, {}, pctx(), "/tmp").behavior).toBe("ask");
	});

	it("manual keeps read-only tools allowed with no prompt available", () => {
		const tool = new FakeTool({ name: "lookup", readOnly: true });
		expect(
			decidePermission(tool, {}, pctx({ interactive: false }), "/tmp"),
		).toEqual({ behavior: "allow", reason: "read-only tool" });
	});

	it("an allow rule still silences a read-only tool in manual", () => {
		const context = pctx({ rules: parseRuleSet({ allow: ["lookup"] }) });
		const tool = new FakeTool({ name: "lookup", readOnly: true });
		expect(decidePermission(tool, {}, context, "/tmp").behavior).toBe("allow");
	});

	it("bypass allows what survives the rules", () => {
		const tool = new FakeTool({ name: "mutate" });
		expect(
			decidePermission(
				tool,
				{ command: "rm x" },
				pctx({ mode: "bypass" }),
				"/tmp",
			).behavior,
		).toBe("allow");
	});

	it("allow rule allows in manual mode", () => {
		const context = pctx({
			rules: parseRuleSet({ allow: ["mutate(bun test:*)"] }),
		});
		const tool = new FakeTool({ name: "mutate" });
		expect(
			decidePermission(tool, { command: "bun test" }, context, "/tmp").behavior,
		).toBe("allow");
	});

	it("requires a path glob to match every path in a patch", () => {
		const tool = new ApplyPatchTool();
		const inside =
			"*** Begin Patch\n" +
			"*** Add File: src/a.ts\n+x\n" +
			"*** Add File: src/b.ts\n+y\n" +
			"*** End Patch";
		const escaping =
			"*** Begin Patch\n" +
			"*** Add File: src/a.ts\n+x\n" +
			"*** Add File: ../../outside\n+y\n" +
			"*** End Patch";
		const context = pctx({
			rules: parseRuleSet({ allow: ["apply_patch(src/**)"] }),
		});

		expect(
			decidePermission(tool, { patch: inside }, context, "/tmp").behavior,
		).toBe("allow");
		expect(
			decidePermission(tool, { patch: escaping }, context, "/tmp").behavior,
		).toBe("ask");
	});

	it("combines multiple allow globs to cover every path", () => {
		const tool = new ApplyPatchTool();
		const patch =
			"*** Begin Patch\n" +
			"*** Add File: src/a.ts\n+x\n" +
			"*** Add File: tests/a.test.ts\n+y\n" +
			"*** End Patch";
		const context = pctx({
			rules: parseRuleSet({
				allow: ["apply_patch(src/**)", "apply_patch(tests/**)"],
			}),
		});

		expect(decidePermission(tool, { patch }, context, "/tmp").behavior).toBe(
			"allow",
		);
	});

	it("normalizes traversal before applying path globs", () => {
		const tool = new ApplyPatchTool();
		const patch =
			"*** Begin Patch\n" +
			"*** Add File: src/../../outside\n+x\n" +
			"*** End Patch";
		const context = pctx({
			rules: parseRuleSet({ allow: ["apply_patch(src/**)"] }),
		});

		expect(decidePermission(tool, { patch }, context, "/tmp").behavior).toBe(
			"ask",
		);
	});

	it("normalizes configured absolute path globs", () => {
		const tool = new ApplyPatchTool();
		const patch =
			"*** Begin Patch\n" +
			"*** Add File: /tmp/project/src/a.ts\n+x\n" +
			"*** End Patch";
		const context = pctx({
			rules: parseRuleSet({ allow: ["apply_patch(/tmp/project/src/**)"] }),
		});

		expect(
			decidePermission(tool, { patch }, context, "/tmp/project").behavior,
		).toBe("allow");
	});

	it("normalizes traversal for Edit and Write path globs", () => {
		for (const tool of [new EditTool(), new WriteTool()]) {
			const context = pctx({
				rules: parseRuleSet({ allow: [`${tool.agentName}(src/**)`] }),
			});
			const input =
				tool instanceof EditTool
					? { file_path: "src/../../outside", edits: [] }
					: { file_path: "src/../../outside", content: "x" };

			expect(decidePermission(tool, input, context, "/tmp").behavior).toBe(
				"ask",
			);
		}
	});

	it("lets deny path globs block any path in a patch", () => {
		const tool = new ApplyPatchTool();
		const patch =
			"*** Begin Patch\n" +
			"*** Add File: src/a.ts\n+x\n" +
			"*** Add File: secrets/key.txt\n+y\n" +
			"*** End Patch";
		const context = pctx({
			rules: parseRuleSet({ deny: ["apply_patch(secrets/**)"] }),
		});

		expect(decidePermission(tool, { patch }, context, "/tmp").behavior).toBe(
			"deny",
		);
	});

	it("falls through to ask with the content attached", () => {
		const tool = new FakeTool({ name: "mutate" });
		const decision = decidePermission(
			tool,
			{ command: "rm -rf /" },
			pctx(),
			"/tmp",
		);
		expect(decision).toEqual({ behavior: "ask", content: "rm -rf /" });
	});
});

describe("decidePermission in auto mode", () => {
	const tool = new ExecuteTool();

	it("allows a non-dangerous command through the tool verdict", () => {
		const decision = decidePermission(
			tool,
			{ command: "bun run deploy" },
			pctx({ mode: "auto" }),
			"/tmp",
		);
		expect(decision).toEqual({ behavior: "allow", reason: "auto mode" });
	});

	it("deny rule beats the auto allow", () => {
		const context = pctx({
			mode: "auto",
			rules: parseRuleSet({ deny: [`${tool.agentName}(bun run deploy:*)`] }),
		});
		expect(
			decidePermission(tool, { command: "bun run deploy" }, context, "/tmp")
				.behavior,
		).toBe("deny");
	});

	it("ask rule beats the auto allow", () => {
		const context = pctx({
			mode: "auto",
			rules: parseRuleSet({ ask: [`${tool.agentName}(bun run deploy:*)`] }),
		});
		expect(
			decidePermission(tool, { command: "bun run deploy" }, context, "/tmp")
				.behavior,
		).toBe("ask");
	});

	it("dangerous commands fall through to ask", () => {
		const decision = decidePermission(
			tool,
			{ command: "git push origin main" },
			pctx({ mode: "auto" }),
			"/tmp",
		);
		expect(decision.behavior).toBe("ask");
	});

	it("deny and ask rules override MCP auto mode", () => {
		const mcp = new McpToolAdapter({
			registeredName: "mcp__docs__search",
			serverName: "docs",
			toolName: "search",
			description: "Search docs",
			inputSchema: { type: "object" },
			trustAnnotations: false,
			timeoutMs: 1_000,
			call: async () => ({ content: [] }),
		});

		for (const behavior of ["deny", "ask"] as const) {
			const context = pctx({
				mode: "auto",
				rules: parseRuleSet({ [behavior]: [mcp.agentName] }),
			});
			expect(decidePermission(mcp, {}, context, "/tmp").behavior).toBe(
				behavior,
			);
		}
	});

	it("prompts for unannotated MCP tools in auto mode", () => {
		const mcp = new McpToolAdapter({
			registeredName: "mcp__mailer__send_email",
			serverName: "mailer",
			toolName: "send_email",
			description: "Send email",
			inputSchema: { type: "object" },
			trustAnnotations: false,
			timeoutMs: 1_000,
			call: async () => ({ content: [] }),
		});

		expect(
			decidePermission(mcp, {}, pctx({ mode: "auto" }), "/tmp").behavior,
		).toBe("ask");
	});

	it("allows trusted read-only MCP tools in auto mode", () => {
		const mcp = new McpToolAdapter({
			registeredName: "mcp__docs__search",
			serverName: "docs",
			toolName: "search",
			description: "Search docs",
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: true },
			trustAnnotations: true,
			timeoutMs: 1_000,
			call: async () => ({ content: [] }),
		});

		expect(decidePermission(mcp, {}, pctx({ mode: "auto" }), "/tmp")).toEqual({
			behavior: "allow",
			reason: "read-only tool",
		});
	});
});
