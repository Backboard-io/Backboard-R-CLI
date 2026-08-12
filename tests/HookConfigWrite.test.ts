import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	addHook,
	addProjectHook,
	addUserHook,
	removeProjectHook,
	removeUserHook,
} from "../src/core/hooks/configWrite.ts";
import {
	loadHookConfig,
	validateHookMatcher,
} from "../src/core/hooks/index.ts";
import type { HookConfigFile, LoadedHook } from "../src/core/hooks/types.ts";

async function tempDir(): Promise<string> {
	return await mkdtemp(path.join(os.tmpdir(), "cli-hookwrite-"));
}

function paths(home: string): { project: string; user: string } {
	return {
		project: path.join(home, "project", ".backboard", "hooks.json"),
		user: path.join(home, ".backboard", "hooks.json"),
	};
}

async function readJson(filePath: string): Promise<HookConfigFile> {
	return JSON.parse(await readFile(filePath, "utf8")) as HookConfigFile;
}

describe("validateHookMatcher", () => {
	it("accepts empty, wildcard, and valid regex", () => {
		expect(validateHookMatcher("")).toBeNull();
		expect(validateHookMatcher("*")).toBeNull();
		expect(validateHookMatcher("Bash")).toBeNull();
		expect(validateHookMatcher("Edit|Write")).toBeNull();
	});

	it("rejects an invalid regex", () => {
		expect(validateHookMatcher("(")).not.toBeNull();
	});
});

describe("addUserHook", () => {
	it("creates the file and group when none exists", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "./lint.sh",
			name: "lint",
		});
		const data = await readJson(p.user);
		expect(data.hooks?.PreToolUse).toEqual([
			{
				matcher: "Bash",
				hooks: [{ type: "command", command: "./lint.sh", name: "lint" }],
			},
		]);
		const loaded = loadHookConfig(p);
		expect(loaded.hooks).toHaveLength(1);
		expect(loaded.hooks[0]?.trusted).toBe(true);
	});

	it("merges into an existing group with the same matcher", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "a",
		});
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "b",
		});
		const data = await readJson(p.user);
		expect(data.hooks?.PreToolUse).toHaveLength(1);
		expect(data.hooks?.PreToolUse?.[0]?.hooks.map((h) => h.command)).toEqual([
			"a",
			"b",
		]);
	});

	it("stores no matcher for non-tool events", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, { event: "SessionStart", command: "echo hi" });
		const data = await readJson(p.user);
		expect(data.hooks?.SessionStart?.[0]?.matcher).toBeUndefined();
	});

	it("rejects an exact duplicate", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "a",
		});
		await expect(
			addUserHook(p, { event: "PreToolUse", matcher: "Bash", command: "a" }),
		).rejects.toThrow(/already exists/);
	});

	it("rejects an empty command", async () => {
		const home = await tempDir();
		const p = paths(home);
		await expect(
			addUserHook(p, { event: "PreToolUse", matcher: "Bash", command: "   " }),
		).rejects.toThrow(/empty/);
	});

	it("rejects an invalid matcher regex", async () => {
		const home = await tempDir();
		const p = paths(home);
		await expect(
			addUserHook(p, { event: "PreToolUse", matcher: "(", command: "a" }),
		).rejects.toThrow(/matcher/i);
	});
});

describe("removeUserHook", () => {
	function asLoaded(input: {
		event: LoadedHook["event"];
		matcher?: string;
		command: string;
	}): LoadedHook {
		return {
			event: input.event,
			matcher: input.matcher,
			hook: { type: "command", command: input.command },
			source: { kind: "user", path: "test" },
			hash: "sha256:test",
			trusted: true,
		};
	}

	function loadUserHook(
		p: { project: string; user: string },
		predicate: (hook: LoadedHook) => boolean,
	): LoadedHook {
		const found = loadHookConfig(p).hooks.find(
			(hook) => hook.source.kind === "user" && predicate(hook),
		);
		if (!found) throw new Error("test setup: hook not loaded");
		return found;
	}

	it("removes the hook and prunes the empty group and event", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "a",
		});
		await removeUserHook(
			p,
			loadUserHook(p, (h) => h.hook.command === "a"),
		);
		const data = await readJson(p.user);
		expect(data.hooks?.PreToolUse).toBeUndefined();
	});

	it("removes one hook but keeps siblings in the group", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "a",
		});
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "b",
		});
		await removeUserHook(
			p,
			loadUserHook(p, (h) => h.hook.command === "a"),
		);
		const data = await readJson(p.user);
		expect(data.hooks?.PreToolUse?.[0]?.hooks.map((h) => h.command)).toEqual([
			"b",
		]);
	});

	it("removes the matching hook when siblings share a command", async () => {
		const home = await tempDir();
		const p = paths(home);
		// Hand-edited config: two hooks share a command but differ by name.
		await mkdir(path.dirname(p.user), { recursive: true });
		await writeFile(
			p.user,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							matcher: "Bash",
							hooks: [
								{ type: "command", command: "guard.sh", name: "first" },
								{ type: "command", command: "guard.sh", name: "second" },
							],
						},
					],
				},
			}),
		);
		await removeUserHook(
			p,
			loadUserHook(p, (h) => h.hook.name === "second"),
		);
		const remaining = (await readJson(p.user)).hooks?.PreToolUse?.[0]?.hooks;
		expect(remaining?.map((h) => h.name)).toEqual(["first"]);
	});

	it("throws when the hook is not present", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addUserHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "a",
		});
		await expect(
			removeUserHook(
				p,
				asLoaded({ event: "PreToolUse", matcher: "Bash", command: "missing" }),
			),
		).rejects.toThrow(/not found/);
	});
});

describe("project hooks", () => {
	it("addProjectHook writes the project file and trusts it for the user", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addProjectHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "./guard.sh",
		});
		const projectData = await readJson(p.project);
		expect(projectData.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
			"./guard.sh",
		);
		const userData = await readJson(p.user);
		expect(userData.trustedProjectHookHashes).toHaveLength(1);
		const loaded = loadHookConfig(p);
		const hook = loaded.hooks.find((h) => h.hook.command === "./guard.sh");
		expect(hook?.source.kind).toBe("project");
		expect(hook?.trusted).toBe(true);
	});

	it("removeProjectHook removes the hook and untrusts it", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addProjectHook(p, {
			event: "PreToolUse",
			matcher: "Bash",
			command: "x",
		});
		const hook = loadHookConfig(p).hooks.find((h) => h.hook.command === "x");
		expect(hook).toBeDefined();
		await removeProjectHook(p, hook as LoadedHook);
		const projectData = await readJson(p.project);
		expect(projectData.hooks?.PreToolUse).toBeUndefined();
		const userData = await readJson(p.user);
		expect(userData.trustedProjectHookHashes ?? []).toEqual([]);
	});

	it("addHook routes by scope", async () => {
		const home = await tempDir();
		const p = paths(home);
		await addHook(p, {
			scope: "user",
			event: "SessionStart",
			command: "echo hi",
		});
		await addHook(p, {
			scope: "project",
			event: "PreToolUse",
			matcher: "Edit",
			command: "echo edit",
		});
		const userData = await readJson(p.user);
		const projectData = await readJson(p.project);
		expect(userData.hooks?.SessionStart?.[0]?.hooks[0]?.command).toBe(
			"echo hi",
		);
		expect(projectData.hooks?.PreToolUse?.[0]?.hooks[0]?.command).toBe(
			"echo edit",
		);
		expect(userData.trustedProjectHookHashes).toHaveLength(1);
	});
});
