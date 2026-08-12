import { describe, expect, it } from "bun:test";
import { ExecuteTool } from "../src/tools/ExecuteTool.tsx";

const ctx = { mode: "manual" as const, cwd: "/tmp", interactive: true };
const headless = { mode: "manual" as const, cwd: "/tmp", interactive: false };

describe("ExecuteTool permissions", () => {
	const tool = new ExecuteTool();

	it("exposes the command as permission content", () => {
		expect(tool.permissionContent({ command: "bun test" })).toBe("bun test");
	});

	it("has no opinion on safe commands, so manual prompts for them", () => {
		expect(
			tool.checkPermissions({ command: "git status" }, ctx),
		).toBeUndefined();
		expect(tool.checkPermissions({ command: "ls" }, ctx)).toBeUndefined();
	});

	it("has no opinion on unsafe commands", () => {
		expect(
			tool.checkPermissions({ command: "git push origin main" }, ctx),
		).toBeUndefined();
	});

	it("never auto-allows fire-and-forget commands", () => {
		expect(
			tool.checkPermissions(
				{ command: "git status", fireAndForget: true },
				ctx,
			),
		).toBeUndefined();
	});
});

describe("ExecuteTool permissions without a prompt available", () => {
	const tool = new ExecuteTool();

	it("keeps the safe list for sub-agents, whose ask would hard-deny", () => {
		expect(tool.checkPermissions({ command: "git status" }, headless)).toEqual({
			behavior: "allow",
			reason: "safe read-only command",
		});
	});

	it("still has no opinion on unsafe commands", () => {
		expect(
			tool.checkPermissions({ command: "git push origin main" }, headless),
		).toBeUndefined();
	});
});

describe("ExecuteTool permissions in acceptEdits mode", () => {
	const tool = new ExecuteTool();
	const acceptEdits = {
		mode: "acceptEdits" as const,
		cwd: "/tmp",
		interactive: true,
	};

	it("keeps the safe list silent", () => {
		expect(
			tool.checkPermissions({ command: "git status" }, acceptEdits),
		).toEqual({ behavior: "allow", reason: "safe read-only command" });
	});

	it("has no opinion on commands off the safe list", () => {
		expect(
			tool.checkPermissions({ command: "bun run build" }, acceptEdits),
		).toBeUndefined();
	});
});

describe("ExecuteTool permissions in auto mode", () => {
	const tool = new ExecuteTool();
	const auto = { mode: "auto" as const, cwd: "/tmp", interactive: true };

	it("allows commands off the safe list", () => {
		expect(tool.checkPermissions({ command: "bun run build" }, auto)).toEqual({
			behavior: "allow",
			reason: "auto mode",
		});
	});

	it("allows non-dangerous fire-and-forget commands", () => {
		expect(
			tool.checkPermissions(
				{ command: "bun run dev", fireAndForget: true },
				auto,
			),
		).toEqual({ behavior: "allow", reason: "auto mode" });
	});

	it("has no opinion on dangerous commands, so they prompt", () => {
		expect(
			tool.checkPermissions({ command: "git push origin main" }, auto),
		).toBeUndefined();
		expect(
			tool.checkPermissions({ command: "rm -rf /" }, auto),
		).toBeUndefined();
	});

	it("surfaces the danger reason as a permission hint", () => {
		expect(tool.permissionHint({ command: "git push origin main" })).toBe(
			"Flagged as risky: publishes to a remote.",
		);
		expect(tool.permissionHint({ command: "bun run build" })).toBeUndefined();
	});

	it("has no opinion when the requested cwd leaves the workspace", () => {
		expect(
			tool.checkPermissions({ command: "bun run build", cwd: ".." }, auto),
		).toBeUndefined();
		expect(
			tool.checkPermissions({ command: "bun run build", cwd: "/etc" }, auto),
		).toBeUndefined();
		expect(
			tool.checkPermissions({ command: "bun run build", cwd: "sub" }, auto),
		).toEqual({ behavior: "allow", reason: "auto mode" });
	});

	it("allows absolute paths inside the workspace in auto mode", () => {
		expect(tool.checkPermissions({ command: "rm /tmp/x.txt" }, auto)).toEqual({
			behavior: "allow",
			reason: "auto mode",
		});
		expect(
			tool.checkPermissions({ command: "rm /etc/hosts" }, auto),
		).toBeUndefined();
	});
});
