import { describe, expect, it } from "bun:test";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	backboardConfigPath,
	deleteBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import { loadBrowserEnv, loadEnv, resolveApiUrl } from "../src/config/env.ts";
import { parseFlags } from "../src/config/flags.ts";
import {
	qProjectConfigDir,
	qProjectHookConfigPath,
	qProjectMcpConfigPath,
	qProjectWorkspaceId,
	qSessionDir,
	qUserHookConfigPath,
	qUserMcpConfigPath,
} from "../src/config/paths.ts";
import { setProviderKey } from "../src/core/keys/ProviderKeyStore.ts";

const env = { apiKey: "test-key", apiUrl: "https://example.test/api" };

describe("Config", () => {
	it("loads saved model and thinking selections", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig(
			{
				apiKey: "file-key",
				model: { provider: "anthropic", model: "claude-sonnet-4.5" },
				thinking: { kind: "level", level: "high" },
				memory: "auto",
				memoryProfile: "code",
			},
			homeDir,
		);

		const config = new Config({ env, argv: [], homeDir });

		expect(config.modelString).toBe("anthropic/claude-sonnet-4.5");
		expect(config.thinking).toEqual({ kind: "level", level: "high" });
		expect(config.memory).toBe("auto");
		expect(config.memoryProfile).toBe("code");
	});

	it("persists a stable project workspace id in the project config", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		const child = path.join(dir, "packages", "app");
		await mkdir(path.join(dir, ".git"), { recursive: true });
		await mkdir(child, { recursive: true });

		const id = qProjectWorkspaceId(child);
		const workspacePath = path.join(dir, ".backboard", "workspace.json");
		const saved = JSON.parse(await readFile(workspacePath, "utf8"));
		expect(saved).toEqual({ id });

		const moved = `${dir}-moved`;
		await rename(dir, moved);
		expect(qProjectWorkspaceId(path.join(moved, "packages", "app"))).toBe(id);

		await rm(moved, { recursive: true, force: true });
	});

	it("gitignores the workspace file it creates", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });

		qProjectWorkspaceId(dir);

		const gitignore = await readFile(
			path.join(dir, ".backboard", ".gitignore"),
			"utf8",
		);
		expect(gitignore).toContain("workspace.json");

		await rm(dir, { recursive: true, force: true });
	});

	it("appends workspace.json to an existing .backboard/.gitignore that lacks it", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });
		await mkdir(path.join(dir, ".backboard"), { recursive: true });
		const gitignorePath = path.join(dir, ".backboard", ".gitignore");
		await writeFile(gitignorePath, "sessions", "utf8");

		qProjectWorkspaceId(dir);

		expect(await readFile(gitignorePath, "utf8")).toBe(
			"sessions\nworkspace.json\n",
		);

		// Already listed: second run leaves the file untouched.
		await writeFile(gitignorePath, "workspace.json\n# custom\n", "utf8");
		await rm(path.join(dir, ".backboard", "workspace.json"));
		qProjectWorkspaceId(dir);
		expect(await readFile(gitignorePath, "utf8")).toBe(
			"workspace.json\n# custom\n",
		);

		await rm(dir, { recursive: true, force: true });
	});

	it("repairs the gitignore when workspace.json predates it", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });
		const backboardDir = path.join(dir, ".backboard");
		await mkdir(backboardDir, { recursive: true });
		await writeFile(
			path.join(backboardDir, "workspace.json"),
			'{"id":"pre-existing-id"}\n',
			"utf8",
		);
		await writeFile(
			path.join(backboardDir, ".gitignore"),
			"sessions\n",
			"utf8",
		);

		expect(qProjectWorkspaceId(dir)).toBe("pre-existing-id");
		expect(await readFile(path.join(backboardDir, ".gitignore"), "utf8")).toBe(
			"sessions\nworkspace.json\n",
		);

		await rm(dir, { recursive: true, force: true });
	});

	it("returns an existing workspace id even when the gitignore repair cannot write", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });
		const backboardDir = path.join(dir, ".backboard");
		await mkdir(backboardDir, { recursive: true });
		await writeFile(
			path.join(backboardDir, "workspace.json"),
			'{"id":"stored-id"}\n',
			"utf8",
		);
		await chmod(backboardDir, 0o555);

		try {
			expect(qProjectWorkspaceId(dir)).toBe("stored-id");
		} finally {
			await chmod(backboardDir, 0o755);
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to a stable in-memory workspace id when the project dir is unwritable", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });
		await chmod(dir, 0o555);

		try {
			const id = qProjectWorkspaceId(dir);
			expect(id).toMatch(/^[0-9a-f]{32}$/);
			expect(qProjectWorkspaceId(dir)).toBe(id);
			await expect(
				Bun.file(path.join(dir, ".backboard", "workspace.json")).exists(),
			).resolves.toBe(false);
		} finally {
			await chmod(dir, 0o755);
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("does not create a project workspace id while constructing config", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });

		new Config({ env, argv: ["--cwd", dir] });

		const workspacePath = path.join(dir, ".backboard", "workspace.json");
		await expect(Bun.file(workspacePath).exists()).resolves.toBe(false);

		await rm(dir, { recursive: true, force: true });
	});

	it("lazily persists the project workspace id when requested", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "cli-workspace-"));
		await mkdir(path.join(dir, ".git"), { recursive: true });
		const config = new Config({ env, argv: ["--cwd", dir] });

		const id = config.getWorkspaceId();

		const workspacePath = path.join(dir, ".backboard", "workspace.json");
		const saved = JSON.parse(await readFile(workspacePath, "utf8"));
		expect(saved).toEqual({ id });

		await rm(dir, { recursive: true, force: true });
	});

	it("treats legacy empty thinking config as automatic", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		const configPath = backboardConfigPath(homeDir);
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				apiKey: "file-key",
				model: { provider: "openai", model: "gpt-5.5" },
				thinking: {},
			}),
		);

		const config = new Config({ env, argv: [], homeDir });

		expect(config.thinking).toBeUndefined();
	});

	it("persists runtime model and thinking selections", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig({ apiKey: "file-key" }, homeDir);
		const config = new Config({ env, argv: [], homeDir });

		config.setModel({ provider: "openai", model: "gpt-5.5-pro" });
		config.setThinking({ kind: "level", level: "max" });
		config.setMemory("readonly");
		await config.saveRuntimeSelection();

		const reopened = new Config({ env, argv: [], homeDir });
		expect(reopened.modelString).toBe("openai/gpt-5.5-pro");
		expect(reopened.thinking).toEqual({ kind: "level", level: "max" });
		expect(reopened.memory).toBe("readonly");
		expect(reopened.memoryProfile).toBe("code");
	});

	it("loads saved dynamic thinking selections", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig(
			{
				apiKey: "file-key",
				thinking: { kind: "dynamic" },
			},
			homeDir,
		);

		const config = new Config({ env, argv: [], homeDir });

		expect(config.thinking).toEqual({ kind: "dynamic" });
	});

	it("persists the notify preference", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig({ apiKey: "file-key" }, homeDir);
		const config = new Config({ env, argv: [], homeDir });

		expect(config.isNotifyEnabled).toBe(false);
		config.setNotifyEnabled(true);
		await config.saveNotifyPreference();

		const reopened = new Config({ env, argv: [], homeDir });
		expect(reopened.isNotifyEnabled).toBe(true);
	});

	it("persists the verbose preference", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig({ apiKey: "file-key" }, homeDir);
		const config = new Config({ env, argv: [], homeDir });

		// Verbose defaults on; toggle it off and confirm the choice survives a reload.
		expect(config.isVerbose).toBe(true);
		config.setVerbose(false);
		await config.saveVerbosePreference();

		const reopened = new Config({ env, argv: [], homeDir });
		expect(reopened.isVerbose).toBe(false);
	});

	it("lets startup flags override saved model and thinking selections", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await saveBackboardConfig(
			{
				apiKey: "file-key",
				model: { provider: "anthropic", model: "claude-sonnet-4.5" },
				thinking: { kind: "level", level: "high" },
				memory: "readonly",
				memoryProfile: "default",
			},
			homeDir,
		);

		const config = new Config({
			env,
			argv: [
				"--model",
				"openai/gpt-5.5",
				"--thinking",
				"off",
				"--memory",
				"auto",
				"--memory-profile",
				"coding",
			],
			homeDir,
		});

		expect(config.modelString).toBe("openai/gpt-5.5");
		expect(config.thinking).toBeNull();
		expect(config.memory).toBe("auto");
		expect(config.memoryProfile).toBe("code");

		await config.saveRuntimeSelection();
		const reopened = new Config({ env, argv: [], homeDir });
		expect(reopened.modelString).toBe("anthropic/claude-sonnet-4.5");
		expect(reopened.thinking).toEqual({ kind: "level", level: "high" });
		expect(reopened.memory).toBe("readonly");
		expect(reopened.memoryProfile).toBe("default");
	});

	it("applies defaults from the coding profile", () => {
		const config = new Config({ env, argv: [] });
		expect(config.modelString).toBe("openai/gpt-5.5");
		expect(config.memory).toBe("auto");
		expect(config.profile.name).toBe("coding");
		expect(config.modelProfile.name).toBe("openai");
		expect(config.isToolEnabled("ApplyPatch")).toBe(true);
		expect(config.isToolEnabled("Write")).toBe(false);
		expect(config.isToolEnabled("Edit")).toBe(false);
	});

	it("selects a compatible default for a keys-only install", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await setProviderKey("anthropic", "sk-ant-test", homeDir);

		await withBackboardEnv({}, async () => {
			const config = new Config({ argv: [], homeDir });
			expect(config.modelString).toBe("anthropic/claude-opus-5");
		});
	});

	it("derives model profiles without changing memory profiles", () => {
		const config = new Config({
			env,
			argv: [
				"--model",
				"anthropic/claude-sonnet-4.5",
				"--memory-profile",
				"default",
			],
		});

		expect(config.modelProfile.name).toBe("anthropic");
		expect(config.memoryProfile).toBe("default");
		expect(config.profile.name).toBe("coding");
		expect(config.isToolEnabled("Write")).toBe(true);
		expect(config.isToolEnabled("Edit")).toBe(true);
		expect(config.isToolEnabled("ApplyPatch")).toBe(false);
	});

	it("honors the --model flag", () => {
		const config = new Config({ env, argv: ["--model", "anthropic/claude"] });
		expect(config.model.provider).toBe("anthropic");
		expect(config.model.model).toBe("claude");
	});

	it("honors startup agent behavior flags", () => {
		const config = new Config({
			env,
			argv: [
				"--model",
				"openai/gpt-5.5",
				"--format",
				"json",
				"--thinking",
				"high",
				"--memory",
				"auto",
				"--memory-profile",
				"coding",
				"--excluded-tools",
				"Read,Execute",
				"--excluded_tools",
				"Read",
			],
		});

		expect(config.format).toBe("json");
		expect(config.thinking).toEqual({ kind: "level", level: "high" });
		expect(config.memory).toBe("auto");
		expect(config.memoryProfile).toBe("code");
		expect(config.excludedTools).toEqual(["read", "execute"]);
		expect(config.isToolEnabled("Read")).toBe(false);
		expect(config.isToolEnabled("Edit")).toBe(false);
		expect(config.isToolEnabled("ApplyPatch")).toBe(true);
	});

	it("parses thinking levels and budgets as semantic intent", () => {
		const level = new Config({
			env,
			argv: ["--model", "openrouter/deepseek", "--thinking", "max"],
		});
		expect(level.thinking).toEqual({ kind: "level", level: "max" });

		const budget = new Config({
			env,
			argv: ["--model", "anthropic/claude", "--thinking", "4096"],
		});
		expect(budget.thinking).toEqual({ kind: "budget", tokens: 4096 });

		const dynamic = new Config({
			env,
			argv: ["--model", "anthropic/claude", "--thinking", "dynamic"],
		});
		expect(dynamic.thinking).toEqual({ kind: "dynamic" });
	});

	it("supports --flag=value form", () => {
		const config = new Config({ env, argv: ["--cwd=/tmp/x"] });
		expect(config.cwd).toBe("/tmp/x");
	});

	it("tracks runtime browser enablement", () => {
		const config = new Config({ env, argv: [] });
		expect(config.isBrowserUseEnabled).toBe(false);
		config.enableBrowserUse();
		expect(config.isBrowserUseEnabled).toBe(true);
		config.setBrowserUseEnabled(false);
		expect(config.isBrowserUseEnabled).toBe(false);
		config.setComputerUseEnabled(true);
		expect(config.isComputerUseEnabled).toBe(true);
		config.setComputerUseEnabled(false);
		expect(config.isComputerUseEnabled).toBe(false);
	});

	it("loads browser environment settings", () => {
		expect(
			loadBrowserEnv({
				BROWSER_PATH: " /Applications/Chrome ",
				CHROME_PATH: "/usr/bin/chromium",
				BROWSER_CDP_URL: " http://127.0.0.1:9222 ",
				BROWSER_WS_URL: " ws://127.0.0.1/devtools/browser/1 ",
				HOME: " /Users/test ",
				LOCALAPPDATA: " C:\\Users\\test\\AppData\\Local ",
				PATH: "/bin:/usr/bin",
				ProgramFiles: " C:\\Program Files ",
				"ProgramFiles(x86)": " C:\\Program Files (x86) ",
			}),
		).toEqual({
			browserPath: "/Applications/Chrome",
			chromePath: "/usr/bin/chromium",
			browserCdpUrl: "http://127.0.0.1:9222",
			browserWsUrl: "ws://127.0.0.1/devtools/browser/1",
			home: "/Users/test",
			localAppData: "C:\\Users\\test\\AppData\\Local",
			path: "/bin:/usr/bin",
			programFiles: "C:\\Program Files",
			programFilesX86: "C:\\Program Files (x86)",
		});
	});

	it("allows runtime model changes", () => {
		const config = new Config({ env, argv: [] });
		expect(config.modelProfile.name).toBe("openai");
		config.setModel({ provider: "openai", model: "gpt-4o" });
		config.setThinking({ kind: "level", level: "low" });
		expect(config.modelString).toBe("openai/gpt-4o");
		expect(config.modelProfile.name).toBe("openai");
		expect(config.thinking).toEqual({ kind: "level", level: "low" });

		config.setModel({ provider: "anthropic", model: "claude-sonnet-4.5" });
		expect(config.modelProfile.name).toBe("anthropic");
		expect(config.isToolEnabled("Edit")).toBe(true);
		expect(config.isToolEnabled("ApplyPatch")).toBe(false);
	});

	it("uses the injected env as-is", () => {
		const config = new Config({
			env: { apiKey: "secret", apiUrl: "https://x.test/api" },
			argv: [],
		});
		expect(config.env.apiUrl).toBe("https://x.test/api");
	});

	it("centralizes Backboard config paths", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "cli-paths-"));
		try {
			await mkdir(path.join(root, ".git"));
			const nested = path.join(root, "packages", "app");
			await mkdir(nested, { recursive: true });

			expect(qProjectConfigDir(nested)).toBe(path.join(root, ".backboard"));
			expect(qProjectMcpConfigPath(nested)).toBe(
				path.join(root, ".backboard", "mcp.json"),
			);
			expect(qProjectHookConfigPath(nested)).toBe(
				path.join(root, ".backboard", "hooks.json"),
			);
			const home = path.join(root, "home");
			expect(qUserMcpConfigPath(home)).toBe(
				path.join(home, ".backboard", "mcp.json"),
			);
			expect(qUserHookConfigPath(home)).toBe(
				path.join(home, ".backboard", "hooks.json"),
			);
			expect(qSessionDir(nested, "sess_x")).toBe(
				path.join(nested, ".backboard", "sessions", "sess_x"),
			);

			const config = new Config({ env, argv: ["--cwd", nested] });
			expect(config.mcpConfigPaths.project).toBe(
				path.join(root, ".backboard", "mcp.json"),
			);
			expect(config.mcpConfigPaths.user).toBe(qUserMcpConfigPath());
			expect(config.hookConfigPaths.project).toBe(
				path.join(root, ".backboard", "hooks.json"),
			);
			expect(config.hookConfigPaths.user).toBe(qUserHookConfigPath());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("loads credentials from ~/.backboard/config.json", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({}, async () => {
			await saveBackboardConfig(
				{ apiKey: "file-key", apiUrl: "https://file.test/api/" },
				homeDir,
			);
			expect(loadEnv({ homeDir })).toEqual({
				apiKey: "file-key",
				apiUrl: "https://file.test/api",
			});
		});
	});

	it("reloads saved credentials into the live env object", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({}, async () => {
			await saveBackboardConfig(
				{ apiKey: "old-key", apiUrl: "https://old.test/api" },
				homeDir,
			);
			const config = new Config({ argv: [], homeDir });
			const liveEnv = config.env;

			await saveBackboardConfig(
				{ apiKey: "new-key", apiUrl: "https://new.test/api/" },
				homeDir,
			);
			config.reloadEnv();

			expect(config.env).toBe(liveEnv);
			expect(config.env).toEqual({
				apiKey: "new-key",
				apiUrl: "https://new.test/api",
			});
		});
	});

	it("lets environment credentials override ~/.backboard config", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv(
			{ apiKey: "env-key", apiUrl: "https://env.test/api/" },
			async () => {
				await saveBackboardConfig(
					{ apiKey: "file-key", apiUrl: "https://file.test/api" },
					homeDir,
				);
				expect(loadEnv({ homeDir })).toEqual({
					apiKey: "env-key",
					apiUrl: "https://env.test/api",
				});
			},
		);
	});

	it("uses environment credentials without reading an invalid saved config", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		const configPath = backboardConfigPath(homeDir);
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(configPath, "{not json");

		await withBackboardEnv(
			{ apiKey: "env-key", apiUrl: "https://env.test/api/" },
			() => {
				expect(loadEnv({ homeDir })).toEqual({
					apiKey: "env-key",
					apiUrl: "https://env.test/api",
				});
			},
		);
	});

	it("uses API keys exactly as provided", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({ apiKey: " env-key " }, () => {
			expect(loadEnv({ homeDir }).apiKey).toBe(" env-key ");
		});

		await withBackboardEnv({}, async () => {
			await saveBackboardConfig({ apiKey: " file-key " }, homeDir);
			expect(loadEnv({ homeDir }).apiKey).toBe(" file-key ");
		});
	});

	it("ignores unusable environment credentials before saved credentials", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({ apiKey: "your_key_here" }, async () => {
			await saveBackboardConfig(
				{ apiKey: "file-key", apiUrl: "https://file.test/api" },
				homeDir,
			);
			expect(loadEnv({ homeDir })).toEqual({
				apiKey: "file-key",
				apiUrl: "https://file.test/api",
			});
		});

		await withBackboardEnv({ apiKey: "   " }, async () => {
			await saveBackboardConfig(
				{ apiKey: "file-key", apiUrl: "https://file.test/api" },
				homeDir,
			);
			expect(loadEnv({ homeDir })).toEqual({
				apiKey: "file-key",
				apiUrl: "https://file.test/api",
			});
		});
	});

	it("lets usable environment credentials override saved credentials", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({ apiKey: "env-key" }, async () => {
			await saveBackboardConfig(
				{ apiKey: "file-key", apiUrl: "https://file.test/api" },
				homeDir,
			);
			expect(loadEnv({ homeDir })).toEqual({
				apiKey: "env-key",
				apiUrl: "https://app.backboard.io/api",
			});
		});
	});

	it("parses login as a command or flag", () => {
		expect(parseFlags(["login"]).login).toBe(true);
		expect(parseFlags(["--login"]).login).toBe(true);
	});

	it("parses logout as a command or flag", () => {
		expect(parseFlags(["logout"]).logout).toBe(true);
		expect(parseFlags(["--logout"]).logout).toBe(true);
	});

	it("defaults LSP off and parses the LSP flag", () => {
		expect(parseFlags([]).lsp).toBeUndefined();
		expect(parseFlags(["--lsp"]).lsp).toBe(true);
		expect(parseFlags(["--lsp=false"]).lsp).toBe(false);
		expect(parseFlags(["--lsp", "true"]).lsp).toBe(true);
		expect(parseFlags(["--no-lsp"]).lsp).toBe(false);
	});

	it("defaults final-verification nudge on and parses the flag", () => {
		expect(new Config({ env, argv: [] }).finalVerificationNudge).toBe(true);
		expect(
			new Config({ env, argv: ["--final-verification"] })
				.finalVerificationNudge,
		).toBe(true);
		expect(
			new Config({ env, argv: ["--final-verification=true"] })
				.finalVerificationNudge,
		).toBe(true);
		expect(
			new Config({ env, argv: ["--final-verification=false"] })
				.finalVerificationNudge,
		).toBe(false);
		expect(
			new Config({ env, argv: ["--no-final-verification"] })
				.finalVerificationNudge,
		).toBe(false);
	});

	it("deletes saved Backboard credentials", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));

		await withBackboardEnv({}, async () => {
			await saveBackboardConfig({ apiKey: "file-key" }, homeDir);
			expect((await deleteBackboardConfig(homeDir)).removed).toBe(true);
			expect((await deleteBackboardConfig(homeDir)).removed).toBe(false);
			expect(() => loadEnv({ homeDir })).toThrow(
				"BACKBOARD_API_KEY is not set",
			);
		});
	});
});

describe("resolveApiUrl", () => {
	it("refuses a non-https API URL", async () => {
		await withBackboardEnv(
			{ apiUrl: "http://attacker.example.com/api" },
			() => {
				expect(() => resolveApiUrl()).toThrow(/non-https/);
			},
		);
	});

	it("allows https and loopback http", async () => {
		await withBackboardEnv({ apiUrl: "https://app.backboard.io/api" }, () => {
			expect(resolveApiUrl()).toBe("https://app.backboard.io/api");
		});
		await withBackboardEnv({ apiUrl: "http://localhost:8000/api" }, () => {
			expect(resolveApiUrl()).toBe("http://localhost:8000/api");
		});
		await withBackboardEnv({ apiUrl: "http://127.0.0.1:8000/api" }, () => {
			expect(resolveApiUrl()).toBe("http://127.0.0.1:8000/api");
		});
		await withBackboardEnv({ apiUrl: "http://127.0.0.53:8000/api" }, () => {
			expect(resolveApiUrl()).toBe("http://127.0.0.53:8000/api");
		});
		await withBackboardEnv(
			{ apiUrl: "http://[::ffff:127.0.0.1]:8000/api" },
			() => {
				expect(resolveApiUrl()).toBe("http://[::ffff:127.0.0.1]:8000/api");
			},
		);
	});

	it("treats the wildcard bind address as non-loopback", async () => {
		await withBackboardEnv({ apiUrl: "http://0.0.0.0:8000/api" }, () => {
			expect(() => resolveApiUrl()).toThrow(/non-https/);
		});
	});

	it("refuses a non-https URL from the config file", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-config-"));
		await withBackboardEnv({}, async () => {
			await saveBackboardConfig(
				{ apiKey: "file-key", apiUrl: "http://192.168.1.10/api" },
				homeDir,
			);
			expect(() => loadEnv({ homeDir })).toThrow(/non-https/);
		});
	});

	it("allows a non-https URL only with the explicit escape hatch", async () => {
		const original = process.env.BACKBOARD_ALLOW_INSECURE_API_URL;
		process.env.BACKBOARD_ALLOW_INSECURE_API_URL = "true";
		try {
			await withBackboardEnv({ apiUrl: "http://10.0.0.5:8000/api" }, () => {
				expect(resolveApiUrl()).toBe("http://10.0.0.5:8000/api");
			});
		} finally {
			if (original === undefined)
				delete process.env.BACKBOARD_ALLOW_INSECURE_API_URL;
			else process.env.BACKBOARD_ALLOW_INSECURE_API_URL = original;
		}
	});
});

async function withBackboardEnv(
	values: { apiKey?: string; apiUrl?: string },
	run: () => Promise<void> | void,
): Promise<void> {
	const originalKey = process.env.BACKBOARD_API_KEY;
	const originalUrl = process.env.BACKBOARD_API_URL;

	setEnv("BACKBOARD_API_KEY", values.apiKey);
	setEnv("BACKBOARD_API_URL", values.apiUrl);

	try {
		await run();
	} finally {
		setEnv("BACKBOARD_API_KEY", originalKey);
		setEnv("BACKBOARD_API_URL", originalUrl);
	}
}

function setEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
