import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendAllowRule,
	loadPermissionSettings,
} from "../src/core/permissions/settings.ts";
import { AskUserTool } from "../src/tools/AskUserTool.tsx";
import { FetchUrlTool } from "../src/tools/FetchUrlTool.tsx";
import { FindMcpTool } from "../src/tools/FindMcpTool.tsx";
import { FindSkillTool } from "../src/tools/FindSkillTool.tsx";
import { TodoWriteTool } from "../src/tools/TodoWriteTool.tsx";
import { WebSearchTool } from "../src/tools/WebSearchTool.tsx";

async function tempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "perm-classification-"));
	// A .git dir makes findRepoRoot treat the temp dir as the project root.
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

describe("network tools are not read-only", () => {
	// FetchUrlTool/WebSearchTool override isReadOnly/isConcurrencySafe with no
	// parameters (same pattern as TodoWriteTool/AskUserTool), so the concrete
	// instance type accepts zero arguments here — that narrower signature is
	// exactly what makes these overrides unconditional regardless of input.
	it("FetchUrlTool.isReadOnly is false", () => {
		expect(new FetchUrlTool().isReadOnly()).toBe(false);
	});

	it("FetchUrlTool.isConcurrencySafe stays true", () => {
		expect(new FetchUrlTool().isConcurrencySafe()).toBe(true);
	});

	it("WebSearchTool.isReadOnly is false", () => {
		expect(new WebSearchTool().isReadOnly()).toBe(false);
	});

	it("WebSearchTool.isConcurrencySafe stays true", () => {
		expect(new WebSearchTool().isConcurrencySafe()).toBe(true);
	});
});

describe("internal tools never gate on permission", () => {
	it("TodoWriteTool.checkPermissions allows", () => {
		const decision = new TodoWriteTool().checkPermissions();
		expect(decision?.behavior).toBe("allow");
	});

	it("AskUserTool.checkPermissions allows", () => {
		const decision = new AskUserTool().checkPermissions();
		expect(decision?.behavior).toBe("allow");
	});
});

describe("discovery tools in auto mode", () => {
	const auto = { mode: "auto" as const, cwd: "/project", interactive: true };
	const manual = {
		mode: "manual" as const,
		cwd: "/project",
		interactive: true,
	};
	const headlessAuto = {
		mode: "auto" as const,
		cwd: "/project",
		interactive: false,
	};

	it("allows MCP discovery before its own confirmation gate", () => {
		const tool = new FindMcpTool(() => undefined);
		expect(tool.checkPermissions({ task: "docs" }, auto)?.behavior).toBe(
			"allow",
		);
		expect(tool.checkPermissions({ task: "docs" }, manual)).toBeUndefined();
		expect(
			tool.checkPermissions({ task: "docs" }, headlessAuto),
		).toBeUndefined();
	});

	it("keeps skill discovery gated because local activation has no confirmation", () => {
		const tool = new FindSkillTool({
			listLocalSkills: async () => [],
			activateSkill: () => ({ selectedName: "", loadedNames: [] }),
			listRemoteSkills: async () => [],
			installRemoteSkill: async () => {
				throw new Error("not used");
			},
		});
		expect(tool.checkPermissions({ task: "docs" }, auto)).toBeUndefined();
		expect(tool.checkPermissions({ task: "docs" }, manual)).toBeUndefined();
		expect(
			tool.checkPermissions({ task: "docs" }, headlessAuto),
		).toBeUndefined();
	});
});

describe("appendAllowRule never crashes the turn", () => {
	it("works normally against a valid, writable project", async () => {
		const cwd = await tempProject();
		expect(() => appendAllowRule(cwd, "execute(bun test:*)")).not.toThrow();
		expect(loadPermissionSettings(cwd).allow).toEqual(["execute(bun test:*)"]);
	});

	it("swallows failures when the settings dir cannot be created", async () => {
		// Make a regular file, then use a path *under* it as cwd: mkdirSync of
		// `<file>/sub/.backboard` fails with ENOTDIR on every platform, no root
		// needed. (tmpdir has no .git ancestor, so findRepoRoot stays here.)
		const dir = await mkdtemp(join(tmpdir(), "perm-badcwd-"));
		const filePath = join(dir, "a-file");
		await writeFile(filePath, "x");
		const badCwd = join(filePath, "sub");
		expect(() => appendAllowRule(badCwd, "execute(rm:*)")).not.toThrow();
		// The failed write must not corrupt anything readable afterwards.
		expect(loadPermissionSettings(badCwd)).toEqual({
			allow: [],
			deny: [],
			ask: [],
		});
	});
});
