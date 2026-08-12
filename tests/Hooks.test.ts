import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolCallRef } from "../src/core/bus/events.ts";
import { runCommandHook } from "../src/core/hooks/commandRunner.ts";
import {
	HookController,
	HookManagerController,
	hookDefinitionHash,
	loadHookConfig,
} from "../src/core/hooks/index.ts";
import type {
	CommandHookConfig,
	LoadedHook,
	PreToolUseHookInput,
} from "../src/core/hooks/types.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { ToolScheduler } from "../src/core/tools/ToolScheduler.ts";
import { makeContext, TestTool } from "./helpers.ts";

describe("hooks", () => {
	it("loads user hooks and only trusts project hooks by hash", async () => {
		const root = await tempDir();
		const home = await tempDir();
		await mkdir(path.join(root, ".git"));
		const projectHook: CommandHookConfig = {
			type: "command",
			name: "project-guard",
			command: "echo {}",
		};
		const projectHash = hookDefinitionHash({
			event: "PreToolUse",
			matcher: "Execute",
			hook: projectHook,
		});
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		await writeJson(projectPath, {
			hooks: {
				PreToolUse: [{ matcher: "Execute", hooks: [projectHook] }],
			},
		});
		await writeJson(userPath, {
			trustedProjectHookHashes: [projectHash],
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [{ type: "command", name: "user-hook", command: "echo {}" }],
					},
				],
			},
		});

		const loaded = loadHookConfig({ project: projectPath, user: userPath });

		expect(loaded.trustedProjectHookHashes).toEqual([projectHash]);
		expect(loaded.hooks.map((hook) => hook.hook.name).sort()).toEqual([
			"project-guard",
			"user-hook",
		]);
		expect(loaded.hooks.every((hook) => hook.trusted)).toBe(true);
		expect(loaded.warnings).toEqual([]);
	});

	it("warns and skips untrusted project hooks", async () => {
		const root = await tempDir();
		const home = await tempDir();
		await mkdir(path.join(root, ".git"));
		const projectHook: CommandHookConfig = {
			type: "command",
			name: "project-guard",
			command: "echo {}",
		};
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		await writeJson(projectPath, {
			hooks: {
				PreToolUse: [{ matcher: "Execute", hooks: [projectHook] }],
			},
		});

		const loaded = loadHookConfig({ project: projectPath, user: userPath });

		expect(loaded.hooks[0]?.trusted).toBe(false);
		expect(loaded.warnings[0]).toContain("Skipped untrusted project hook");
		expect(loaded.warnings[0]).toContain(loaded.hooks[0]?.hash ?? "");
	});

	it("warns when a tool hook has an invalid matcher regex", async () => {
		const home = await tempDir();
		const userPath = path.join(home, ".backboard", "hooks.json");
		await writeJson(userPath, {
			hooks: {
				PreToolUse: [
					{ matcher: "(", hooks: [{ type: "command", command: "echo {}" }] },
				],
			},
		});

		const loaded = loadHookConfig({
			project: path.join(home, "missing.json"),
			user: userPath,
		});

		expect(loaded.hooks).toHaveLength(1);
		expect(loaded.warnings.some((w) => w.includes("invalid matcher"))).toBe(
			true,
		);
	});

	it("runs command hooks with JSON stdin and sanitized Q_ env", async () => {
		const dir = await tempDir();
		const script = path.join(dir, "hook.js");
		await writeFile(
			script,
			[
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const parsed = JSON.parse(input);",
				"  process.stdout.write(JSON.stringify({",
				"    systemMessage: process.env.Q_SESSION_ID,",
				"    hookSpecificOutput: { additionalContext: parsed.tool_name }",
				"  }));",
				"});",
			].join("\n"),
		);
		const hook = loadedHook({
			event: "PreToolUse",
			command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
		});
		const input: PreToolUseHookInput = {
			session_id: "sess_test",
			cwd: dir,
			hook_event_name: "PreToolUse",
			timestamp: new Date().toISOString(),
			tool_use_id: "call_test",
			tool_name: "Read",
			tool_input: { path: "README.md" },
		};

		const result = await runCommandHook(hook, input, {
			cwd: dir,
			projectDir: dir,
			sessionId: "sess_test",
			signal: new AbortController().signal,
		});

		expect(result.status).toBe("success");
		if (result.status !== "success") throw new Error("expected success");
		expect(result.output.systemMessage).toBe("sess_test");
		expect(result.output.hookSpecificOutput?.additionalContext).toBe("Read");
	});

	it("blocks prompts when a trusted hook denies UserPromptSubmit", async () => {
		const dir = await tempDir();
		const script = path.join(dir, "block.js");
		await writeFile(
			script,
			"process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'blocked prompt' }));",
		);
		const controller = new HookController({
			hooks: [
				loadedHook({
					event: "UserPromptSubmit",
					command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
				}),
			],
			bus: new EventBus(),
			cwd: dir,
			sessionId: "sess_test",
		});

		const result = await controller.runUserPromptSubmit({
			turnId: "turn_test",
			prompt: "hello",
			signal: new AbortController().signal,
		});

		expect(result.blockedReason).toBe("blocked prompt");
	});

	it("summarizes hook events for the read-only manager", async () => {
		const root = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		await writeJson(userPath, {
			hooks: {
				PreToolUse: [
					{
						matcher: "Read",
						hooks: [
							{ type: "command", command: "echo {}" },
							{ type: "command", command: "echo {}" },
						],
					},
				],
				PostToolUse: [
					{
						matcher: "*",
						hooks: [{ type: "command", command: "echo {}" }],
					},
				],
			},
		});
		const manager = new HookManagerController({
			project: projectPath,
			user: userPath,
		});

		const snapshot = manager.snapshot();

		expect(
			snapshot.events.find((event) => event.event === "PreToolUse"),
		).toMatchObject({
			total: 2,
			trusted: 2,
			untrusted: 0,
		});
		expect(
			snapshot.events.find((event) => event.event === "PostToolUse"),
		).toMatchObject({
			total: 1,
			trusted: 1,
			untrusted: 0,
		});
		expect(snapshot.paths.user).toBe(userPath);
	});

	it("adds a user hook, applies it live, and returns an updated snapshot", async () => {
		const home = await tempDir();
		const userPath = path.join(home, ".backboard", "hooks.json");
		const projectPath = path.join(home, "p", ".backboard", "hooks.json");
		let applied: LoadedHook[] | null = null;
		const manager = new HookManagerController(
			{ project: projectPath, user: userPath },
			{ applyHooks: (hooks) => (applied = hooks) },
		);

		const snapshot = await manager.addHook({
			scope: "user",
			event: "PreToolUse",
			matcher: "Bash",
			command: "./lint.sh",
		});

		expect(
			snapshot.events.find((event) => event.event === "PreToolUse"),
		).toMatchObject({ total: 1, trusted: 1 });
		expect(applied).not.toBeNull();
		expect(
			(applied as unknown as LoadedHook[]).map((h) => h.hook.command),
		).toEqual(["./lint.sh"]);
	});

	it("removes a user hook and applies the change live", async () => {
		const home = await tempDir();
		const userPath = path.join(home, ".backboard", "hooks.json");
		const projectPath = path.join(home, "p", ".backboard", "hooks.json");
		let applied: LoadedHook[] | null = null;
		const manager = new HookManagerController(
			{ project: projectPath, user: userPath },
			{ applyHooks: (hooks) => (applied = hooks) },
		);
		await manager.addHook({
			scope: "user",
			event: "PreToolUse",
			matcher: "Bash",
			command: "x",
		});
		const afterAdd = manager.snapshot();
		const added = afterAdd.hooks.find((hook) => hook.hook.command === "x");
		expect(added).toBeDefined();

		const snapshot = await manager.removeHook(added as LoadedHook);

		expect(snapshot.hooks).toHaveLength(0);
		expect((applied as unknown as LoadedHook[]).length).toBe(0);
	});

	it("runs one command hook for each supported event", async () => {
		const root = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		const logPath = path.join(root, "hooks.log");
		const script = path.join(root, "hook-smoke.js");
		await writeFile(
			script,
			[
				'const fs = require("node:fs");',
				"const logPath = process.argv[2];",
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', chunk => input += chunk);",
				"process.stdin.on('end', () => {",
				"  const parsed = JSON.parse(input);",
				"  const target = parsed.tool_name ?? parsed.source ?? 'prompt';",
				"  fs.appendFileSync(logPath, parsed.hook_event_name + ':' + target + '\\n');",
				"  if (parsed.hook_event_name === 'UserPromptSubmit') {",
				"    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: 'prompt context' } }));",
				"    return;",
				"  }",
				"  if (parsed.hook_event_name === 'PreToolUse') {",
				"    process.stdout.write(JSON.stringify({ hookSpecificOutput: { updatedInput: { value: 'pre-updated' }, additionalContext: 'pre context' } }));",
				"    return;",
				"  }",
				"  if (parsed.hook_event_name === 'PostToolUse') {",
				"    process.stdout.write(JSON.stringify({ hookSpecificOutput: { replacementOutput: 'post saw ' + parsed.tool_response.output, additionalContext: 'post context' } }));",
				"    return;",
				"  }",
				"  process.stdout.write('{}');",
				"});",
			].join("\n"),
		);
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
			script,
		)} ${JSON.stringify(logPath)}`;
		const hook = { type: "command", command };
		await writeJson(userPath, {
			hooks: {
				SessionStart: [{ matcher: "startup", hooks: [hook] }],
				UserPromptSubmit: [{ hooks: [hook] }],
				PreToolUse: [{ matcher: "Smoke", hooks: [hook] }],
				PostToolUse: [{ matcher: "Smoke", hooks: [hook] }],
			},
		});

		const loaded = loadHookConfig({ project: projectPath, user: userPath });
		const controller = new HookController({
			hooks: loaded.hooks,
			bus: new EventBus(),
			cwd: root,
			sessionId: "sess_test",
		});
		const signal = new AbortController().signal;

		await controller.runSessionStart("startup", signal);
		const promptResult = await controller.runUserPromptSubmit({
			turnId: "turn_test",
			prompt: "hello",
			signal,
		});
		expect(promptResult.additionalContext).toBe("prompt context");

		const scheduler = new ToolScheduler(
			new ToolRegistry([new TestTool({ name: "Smoke" })]),
			new EventBus(),
			() => true,
			controller,
		);
		const calls: ToolCallRef[] = [
			{ id: "call_smoke", name: "Smoke", input: { value: "initial" } },
		];
		const outputs = await scheduler.run(calls, {
			...makeContext(signal),
			cwd: root,
			sessionId: "sess_test",
			turnId: "turn_test",
		});

		expect(outputs[0]?.output).toContain("post saw pre-updated");
		expect(outputs[0]?.output).toContain("post context");
		expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
			"SessionStart:startup",
			"UserPromptSubmit:prompt",
			"PreToolUse:Smoke",
			"PostToolUse:Smoke",
		]);
	});

	it("runs Stop and SessionEnd hooks with their input fields", async () => {
		const root = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		const logPath = path.join(root, "lifecycle.log");
		const script = path.join(root, "lifecycle.js");
		await writeFile(
			script,
			[
				'const fs = require("node:fs");',
				"const logPath = process.argv[2];",
				"let input = '';",
				"process.stdin.setEncoding('utf8');",
				"process.stdin.on('data', (chunk) => (input += chunk));",
				"process.stdin.on('end', () => {",
				"  const parsed = JSON.parse(input);",
				"  fs.appendFileSync(logPath, parsed.hook_event_name + ':' + (parsed.reason ?? parsed.turn_id ?? '') + '\\n');",
				"  process.stdout.write('{}');",
				"});",
			].join("\n"),
		);
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
			script,
		)} ${JSON.stringify(logPath)}`;
		const hook = { type: "command", command };
		await writeJson(userPath, {
			hooks: {
				Stop: [{ hooks: [hook] }],
				SessionEnd: [{ hooks: [hook] }],
			},
		});

		const loaded = loadHookConfig({ project: projectPath, user: userPath });
		const controller = new HookController({
			hooks: loaded.hooks,
			bus: new EventBus(),
			cwd: root,
			sessionId: "sess_test",
		});
		const signal = new AbortController().signal;

		await controller.runStop({ turnId: "turn_test", signal });
		await controller.runSessionEnd("exit", signal);

		expect((await readFile(logPath, "utf8")).trim().split("\n")).toEqual([
			"Stop:turn_test",
			"SessionEnd:exit",
		]);
	});

	it("blocks a tool when a PreToolUse hook denies via permissionDecision", async () => {
		const root = await tempDir();
		const command = `echo '${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "not allowed",
			},
		})}'`;
		const controller = new HookController({
			hooks: [loadedHook({ event: "PreToolUse", matcher: "Smoke", command })],
			bus: new EventBus(),
			cwd: root,
			sessionId: "s",
		});
		const result = await controller.runPreToolUse({
			toolCallId: "c",
			toolName: "Smoke",
			toolInput: {},
			signal: new AbortController().signal,
		});
		expect(result.deniedReason).toBe("not allowed");
	});

	it("does not leak additionalContext from a denied PostToolUse hook", async () => {
		const root = await tempDir();
		const command = `echo '${JSON.stringify({
			decision: "deny",
			reason: "blocked",
			hookSpecificOutput: { additionalContext: "secret leak" },
		})}'`;
		const controller = new HookController({
			hooks: [loadedHook({ event: "PostToolUse", matcher: "Smoke", command })],
			bus: new EventBus(),
			cwd: root,
			sessionId: "s",
		});
		const result = await controller.runPostToolUse({
			toolCallId: "c",
			toolName: "Smoke",
			toolInput: {},
			output: "original",
			isError: false,
			signal: new AbortController().signal,
		});
		expect(result.output).toBe("Error: blocked");
		expect(result.additionalContext).toBeUndefined();
		expect(result.denied).toBe(true);
	});

	it("ignores a stray matcher on non-tool events instead of dropping the hook", async () => {
		const dir = await tempDir();
		const logPath = path.join(dir, "stop.log");
		const script = path.join(dir, "stop.js");
		await writeFile(
			script,
			[
				'const fs = require("node:fs");',
				"fs.writeFileSync(process.argv[2], 'ran');",
				"process.stdout.write('{}');",
			].join("\n"),
		);
		const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(
			script,
		)} ${JSON.stringify(logPath)}`;
		const controller = new HookController({
			hooks: [loadedHook({ event: "Stop", matcher: "SomeMatcher", command })],
			bus: new EventBus(),
			cwd: dir,
			sessionId: "s",
		});

		await controller.runStop({
			turnId: "t",
			status: "cancelled",
			signal: new AbortController().signal,
		});

		expect((await readFile(logPath, "utf8")).trim()).toBe("ran");
	});

	it("anchors tool matchers so 'Edit' does not match 'MultiEdit'", () => {
		const controller = new HookController({
			hooks: [
				loadedHook({
					event: "PreToolUse",
					matcher: "Edit",
					command: "echo {}",
				}),
			],
			bus: new EventBus(),
			cwd: ".",
			sessionId: "s",
		});
		expect(controller.hasTrustedToolHooksFor("Edit")).toBe(true);
		expect(controller.hasTrustedToolHooksFor("MultiEdit")).toBe(false);
		expect(controller.hasTrustedToolHooksFor("NotebookEdit")).toBe(false);
	});

	it("loads hooks despite an unknown top-level key in hooks.json", async () => {
		const root = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(root, ".backboard", "hooks.json");
		const userPath = path.join(home, ".backboard", "hooks.json");
		await writeJson(userPath, {
			$schema: "https://example.com/schema.json",
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "echo {}" }] }],
			},
		});
		const loaded = loadHookConfig({ project: projectPath, user: userPath });
		expect(loaded.hooks).toHaveLength(1);
		expect(loaded.warnings).toEqual([]);
	});

	it("kills a SIGTERM-trapping hook via escalation instead of hanging", async () => {
		const dir = await tempDir();
		const hook: LoadedHook = {
			event: "PreToolUse",
			matcher: undefined,
			hook: {
				type: "command",
				command: "trap '' TERM; while :; do sleep 1; done",
				timeoutMs: 200,
			},
			source: { kind: "user", path: "test" },
			hash: "sha256:test",
			trusted: true,
		};
		const input: PreToolUseHookInput = {
			session_id: "s",
			cwd: dir,
			hook_event_name: "PreToolUse",
			timestamp: new Date().toISOString(),
			tool_use_id: "c",
			tool_name: "X",
			tool_input: {},
		};
		const result = await runCommandHook(hook, input, {
			cwd: dir,
			projectDir: dir,
			sessionId: "s",
			signal: new AbortController().signal,
		});
		expect(result.status).toBe("warning");
		if (result.status === "warning") {
			expect(result.warning).toContain("timed out");
		}
	});

	it("does not spawn a hook when the signal is already aborted", async () => {
		const dir = await tempDir();
		const marker = path.join(dir, "ran.marker");
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
			`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`,
		)}`;
		const hook = loadedHook({ event: "Stop", command });
		const input: PreToolUseHookInput = {
			session_id: "s",
			cwd: dir,
			hook_event_name: "PreToolUse",
			timestamp: new Date().toISOString(),
			tool_use_id: "c",
			tool_name: "X",
			tool_input: {},
		};
		const controller = new AbortController();
		controller.abort();

		const result = await runCommandHook(hook, input, {
			cwd: dir,
			projectDir: dir,
			sessionId: "s",
			signal: controller.signal,
		});

		expect(result.status).toBe("warning");
		if (result.status === "warning") {
			expect(result.warning).toContain("aborted");
		}
		expect(existsSync(marker)).toBe(false);
	});

	it("does not crash when a hook exits without reading stdin", async () => {
		const dir = await tempDir();
		const hook = loadedHook({
			event: "PreToolUse",
			command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
		});
		const input: PreToolUseHookInput = {
			session_id: "s",
			cwd: dir,
			hook_event_name: "PreToolUse",
			timestamp: new Date().toISOString(),
			tool_use_id: "c",
			tool_name: "X",
			tool_input: {},
		};
		const result = await runCommandHook(hook, input, {
			cwd: dir,
			projectDir: dir,
			sessionId: "s",
			signal: new AbortController().signal,
		});
		expect(result.status).toBe("success");
	});

	it("terminates and warns when a hook floods stdout", async () => {
		const dir = await tempDir();
		const script = path.join(dir, "flood.js");
		await writeFile(script, "process.stdout.write('x'.repeat(60000));");
		const hook = loadedHook({
			event: "PreToolUse",
			command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
		});
		const input: PreToolUseHookInput = {
			session_id: "s",
			cwd: dir,
			hook_event_name: "PreToolUse",
			timestamp: new Date().toISOString(),
			tool_use_id: "c",
			tool_name: "X",
			tool_input: {},
		};
		const result = await runCommandHook(hook, input, {
			cwd: dir,
			projectDir: dir,
			sessionId: "s",
			signal: new AbortController().signal,
		});
		expect(result.status).toBe("warning");
		if (result.status === "warning") {
			expect(result.warning).toContain("more than");
		}
	});

	it("honors a JSON deny that carries an unknown forward-compat key", async () => {
		const root = await tempDir();
		const command = `echo '${JSON.stringify({
			decision: "deny",
			reason: "nope",
			suppressOutput: true,
		})}'`;
		const controller = new HookController({
			hooks: [loadedHook({ event: "PreToolUse", matcher: "Smoke", command })],
			bus: new EventBus(),
			cwd: root,
			sessionId: "s",
		});
		const result = await controller.runPreToolUse({
			toolCallId: "c",
			toolName: "Smoke",
			toolInput: {},
			signal: new AbortController().signal,
		});
		expect(result.deniedReason).toBe("nope");
	});
});

async function tempDir(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "q-cli-hooks-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadedHook(input: {
	event: LoadedHook["event"];
	command: string;
	matcher?: string;
}): LoadedHook {
	const hook: CommandHookConfig = {
		type: "command",
		command: input.command,
	};
	const hash = hookDefinitionHash({
		event: input.event,
		matcher: input.matcher,
		hook,
	});
	return {
		event: input.event,
		matcher: input.matcher,
		hook,
		source: { kind: "user", path: "test" },
		hash,
		trusted: true,
	};
}
