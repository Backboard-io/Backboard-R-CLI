import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import type {
	IncomingMessage,
	RequestListener,
	ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	disableConfiguredMcpServer,
	disableProjectMcpServer,
	filterMcpListedToolDefinitions,
	isMcpPromptEnabled,
	isMcpResourceEnabled,
	isMcpToolEnabled,
	listMcpRegistryServers,
	listMcpServerPromptDefinitions,
	listMcpServerResourceDefinitions,
	listMcpServerResourceTemplateDefinitions,
	loadMcpConfig,
	type McpCallResult,
	McpClientManager,
	McpController,
	type McpListedToolDefinition,
	type McpRegistryServer,
	type McpServerConfig,
	type McpServerRuntimeStatus,
	type McpToolDefinition,
	mcpFunctionName,
	parseManualMcpInput,
	removeConfiguredMcpServer,
	removeProjectMcpServer,
	resourceTemplateVariables,
	saveProjectMcpServer,
} from "../src/core/mcp/index.ts";
import { McpPrimitiveManager } from "../src/core/mcp/MCPPrimitiveManager.ts";
import {
	listMcpServerToolDefinitions,
	listMcpServerToolDefinitionsIfSupported,
} from "../src/core/mcp/MCPToolDefinitions.ts";
import type { McpConnection } from "../src/core/mcp/MCPTypes.ts";
import {
	McpAuthenticationRequiredError,
	McpOAuthProvider,
} from "../src/core/mcp/oauth.ts";
import { McpToolAdapter } from "../src/tools/MCPToolAdapter.tsx";
import { makeContext } from "./helpers.ts";

describe("MCP config", () => {
	it("layers project and user config with user fields winning", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		const nested = path.join(root, "packages", "app");
		await mkdir(nested, { recursive: true });
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			timeoutMs: 1_000,
			mcpServers: {
				shared: {
					command: "node",
					args: [envRef("PKG:-project-pkg")],
					env: { TOKEN: envRef("PROJECT_TOKEN") },
					disabledTools: ["drop"],
					disabledPrompts: ["old-prompt"],
					disabledResources: ["file://old"],
					timeoutMs: 3_000,
				},
				docs: {
					type: "http",
					url: `https://${envRef("DOCS_HOST:-docs.example.com")}/mcp`,
					headers: { Authorization: `Bearer ${envRef("DOCS_TOKEN")}` },
				},
			},
		});

		const home = await tempDir();
		await writeJson(path.join(home, ".backboard", "mcp.json"), {
			timeoutMs: 2_000,
			mcpServers: {
				shared: {
					disabled: true,
					enabledTools: ["keep"],
					enabledPrompts: ["new-prompt"],
					enabledResources: ["file://new"],
					env: { TOKEN: envRef("USER_TOKEN:-user-token") },
				},
				personal: {
					type: "streamable-http",
					url: envRef("PERSONAL_URL:-https://personal.example.com/mcp"),
				},
			},
		});

		const config = await loadMcpConfig({
			cwd: nested,
			homeDir: home,
			env: { PROJECT_TOKEN: "project-token" },
		});
		const projectConfigPath = path.join(root, ".backboard", "mcp.json");
		const userConfigPath = path.join(home, ".backboard", "mcp.json");

		expect(config.timeoutMs).toBe(2_000);
		const shared = expectServer(config.servers, "shared");
		expect(shared.configSources).toEqual([
			{ scope: "project", path: projectConfigPath },
			{ scope: "user", path: userConfigPath },
		]);
		expect(shared.disabled).toBe(true);
		expect(shared.command).toBe("node");
		expect(shared.args).toEqual(["project-pkg"]);
		expect(shared.env.TOKEN).toBe("user-token");
		expect(shared.enabledTools).toEqual(["keep"]);
		expect(shared.disabledTools).toEqual(["drop"]);
		expect(shared.enabledPrompts).toEqual(["new-prompt"]);
		expect(shared.disabledPrompts).toEqual(["old-prompt"]);
		expect(shared.enabledResources).toEqual(["file://new"]);
		expect(shared.disabledResources).toEqual(["file://old"]);
		expect(shared.timeoutMs).toBe(3_000);

		const docs = expectServer(config.servers, "docs");
		expect(docs.configSources).toEqual([
			{ scope: "project", path: projectConfigPath },
		]);
		expect(docs.url).toBe("https://docs.example.com/mcp");
		expect(docs.headers.Authorization).toBe(`Bearer ${envRef("DOCS_TOKEN")}`);
		expect(
			config.warnings.some((warning) => warning.includes("DOCS_TOKEN")),
		).toBe(true);

		const personal = expectServer(config.servers, "personal");
		expect(personal.configSources).toEqual([
			{ scope: "user", path: userConfigPath },
		]);
		expect(personal.type).toBe("http");
		expect(personal.url).toBe("https://personal.example.com/mcp");
	});

	it("lets enabledTools take precedence over disabledTools", () => {
		const server = {
			enabledTools: ["keep"],
			disabledTools: ["keep", "drop"],
		};

		expect(isMcpToolEnabled("keep", server)).toBe(true);
		expect(isMcpToolEnabled("drop", server)).toBe(false);
	});

	it("lets MCP prompt and resource allowlists take precedence over blocklists", () => {
		expect(
			isMcpPromptEnabled("keep", {
				enabledPrompts: ["keep"],
				disabledPrompts: ["keep", "drop"],
			}),
		).toBe(true);
		expect(
			isMcpPromptEnabled("drop", {
				enabledPrompts: ["keep"],
				disabledPrompts: ["keep", "drop"],
			}),
		).toBe(false);
		expect(
			isMcpResourceEnabled("file://keep", {
				enabledResources: ["file://keep"],
				disabledResources: ["file://keep", "file://drop"],
			}),
		).toBe(true);
		expect(
			isMcpResourceEnabled("file://drop", {
				enabledResources: ["file://keep"],
				disabledResources: ["file://keep", "file://drop"],
			}),
		).toBe(false);
	});

	it("filters MCP tool definitions through enabledTools and disabledTools", () => {
		const tools = [
			listedDefinition("keep"),
			listedDefinition("drop"),
			listedDefinition("other"),
		];

		expect(
			filterMcpListedToolDefinitions(
				{ enabledTools: ["keep"], disabledTools: [] },
				tools,
			).map((tool) => tool.toolName),
		).toEqual(["keep"]);
		expect(
			filterMcpListedToolDefinitions({ disabledTools: ["drop"] }, tools).map(
				(tool) => tool.toolName,
			),
		).toEqual(["keep", "other"]);
	});

	it("honors trustToolAnnotations from user config only", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			mcpServers: {
				fromProject: {
					type: "http",
					url: "https://project.example.com/mcp",
					trustToolAnnotations: true,
				},
			},
		});
		const home = await tempDir();
		await writeJson(path.join(home, ".backboard", "mcp.json"), {
			mcpServers: {
				fromUser: {
					type: "http",
					url: "https://user.example.com/mcp",
					trustToolAnnotations: true,
				},
			},
		});

		const config = await loadMcpConfig({ cwd: root, homeDir: home });

		expect(
			expectServer(config.servers, "fromProject").trustToolAnnotations,
		).toBe(false);
		expect(expectServer(config.servers, "fromUser").trustToolAnnotations).toBe(
			true,
		);
		expect(
			config.warnings.some((warning) =>
				warning.includes("Ignored trustToolAnnotations"),
			),
		).toBe(true);
	});

	it("defaults trustToolAnnotations to false", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			mcpServers: { plain: { type: "http", url: "https://example.com/mcp" } },
		});

		const config = await loadMcpConfig({ cwd: root, homeDir: await tempDir() });

		expect(expectServer(config.servers, "plain").trustToolAnnotations).toBe(
			false,
		);
	});

	it("rejects unsupported SSE servers with a warning", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			mcpServers: {
				legacy: { type: "sse", url: "https://example.com/sse" },
			},
		});

		const config = await loadMcpConfig({
			cwd: root,
			homeDir: await tempDir(),
		});

		expect(config.servers).toEqual([]);
		expect(config.warnings.some((warning) => warning.includes("SSE"))).toBe(
			true,
		);
	});

	it("lists the curated MCP catalog without fetching remote registry data", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = Object.assign(
			async () => {
				throw new Error("curated MCP catalog should not fetch");
			},
			{ preconnect: originalFetch.preconnect },
		) as typeof fetch;
		try {
			const servers = await listMcpRegistryServers();

			expect(servers.map((server) => server.title).slice(0, 21)).toEqual([
				"Sentry",
				"Hugging Face",
				"Socket",
				"Playwright",
				"Context7",
				"Notion",
				"Linear",
				"Intercom",
				"Monday",
				"Stripe",
				"PayPal",
				"Figma",
				"Canva",
				"TwelveLabs",
				"Netlify",
				"Vercel",
				"Airtable",
				"ClickUp",
				"HubSpot",
				"MongoDB",
				"Supabase",
			]);
			expect(servers.length).toBeGreaterThan(215);
			expect(
				servers.find((server) => server.name === "linear")?.config,
			).toEqual({
				type: "streamable-http",
				url: "https://mcp.linear.app/mcp",
			});
			expect(
				servers.find((server) => server.name === "context7")?.config,
			).toEqual({
				command: "npx",
				args: ["-y", "@upstash/context7-mcp@latest"],
			});
			expect(servers.find((server) => server.name === "socket")).toMatchObject({
				config: {
					command: "npx",
					args: ["-y", "@socketsecurity/mcp"],
					env: { SOCKET_API_TOKEN: envRef("SOCKET_API_KEY") },
				},
				requiredEnv: ["SOCKET_API_KEY"],
			});
			expect(servers.find((server) => server.name === "stripe")).toMatchObject({
				category: "Payments & Commerce",
				config: {
					type: "streamable-http",
					url: "https://mcp.stripe.com",
				},
				requiredEnv: [],
			});
			expect(servers.find((server) => server.name === "paypal")).toMatchObject({
				config: {
					command: "npx",
					args: ["-y", "@paypal/mcp", "--tools=all"],
					env: {
						PAYPAL_ACCESS_TOKEN: envRef("PAYPAL_ACCESS_TOKEN"),
						PAYPAL_ENVIRONMENT: envRef("PAYPAL_ENVIRONMENT:-SANDBOX"),
					},
				},
				requiredEnv: ["PAYPAL_ACCESS_TOKEN"],
			});
			expect(
				servers.find((server) => server.name === "twelvelabs"),
			).toMatchObject({
				config: {
					command: "npx",
					args: ["-y", "--package", "twelvelabs-mcp", "twelvelabs-mcp-stdio"],
					env: { TWELVE_LABS_API_KEY: envRef("TWELVE_LABS_API_KEY") },
				},
				requiredEnv: ["TWELVE_LABS_API_KEY"],
			});
			expect(servers.find((server) => server.name === "mongodb")).toMatchObject(
				{
					category: "Additional Stdio Servers",
					config: {
						command: "npx",
						args: ["-y", "mongodb-mcp-server"],
						env: { MDB_MCP_CONNECTION_STRING: envRef("MONGODB_URI") },
					},
					requiredEnv: ["MONGODB_URI"],
				},
			);
			expect(servers.find((server) => server.name === "figma")).toMatchObject({
				description: "Remote server only supports approved Figma MCP clients",
				disabledReason: expect.stringContaining("figma-desktop="),
			});
			expect(servers.find((server) => server.name === "stytch")).toMatchObject({
				category: "Remote Servers",
				config: {
					type: "streamable-http",
					url: "https://mcp.stytch.dev/mcp",
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("parses manual MCP URL and command inputs", () => {
		const remote = parseManualMcpInput("linear=https://linear.example.com/mcp");
		expect(remote.name).toBe("linear");
		expect(remote.config).toEqual({
			type: "http",
			url: "https://linear.example.com/mcp",
		});

		const command = parseManualMcpInput(
			"npx -y @modelcontextprotocol/server-github",
		);
		expect(command.name).toBe("server-github");
		expect(command.config).toEqual({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github"],
		});
	});

	it("writes project MCP config without expanding secrets", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			timeoutMs: 5_000,
			mcpServers: {
				existing: { url: "https://existing.example.com/mcp" },
			},
		});

		const filePath = await saveProjectMcpServer(root, "new-server", {
			type: "http",
			url: envRef("MCP_URL"),
			headers: { Authorization: envRef("MCP_TOKEN") },
		});
		const saved = JSON.parse(await readFile(filePath, "utf8")) as {
			timeoutMs: number;
			mcpServers: Record<string, unknown>;
		};

		expect(saved.timeoutMs).toBe(5_000);
		expect(saved.mcpServers.existing).toEqual({
			url: "https://existing.example.com/mcp",
		});
		expect(saved.mcpServers["new-server"]).toEqual({
			type: "http",
			url: envRef("MCP_URL"),
			headers: { Authorization: envRef("MCP_TOKEN") },
		});
	});

	it("does not overwrite an existing project MCP server", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		await writeJson(path.join(root, ".backboard", "mcp.json"), {
			mcpServers: {
				existing: { url: "https://existing.example.com/mcp" },
			},
		});

		await expect(
			saveProjectMcpServer(root, "existing", {
				url: "https://new.example.com/mcp",
			}),
		).rejects.toThrow("already exists");
	});

	it("disables and removes project MCP servers without expanding values", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		const configPath = path.join(root, ".backboard", "mcp.json");
		await writeJson(configPath, {
			mcpServers: {
				existing: {
					type: "http",
					url: envRef("EXISTING_URL"),
					headers: { Authorization: envRef("EXISTING_TOKEN") },
				},
				keep: { command: "node", args: ["server.js"] },
			},
		});

		await disableProjectMcpServer(root, "existing");
		await disableProjectMcpServer(root, "user-server");
		let saved = JSON.parse(await readFile(configPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(saved.mcpServers.existing).toEqual({
			type: "http",
			url: envRef("EXISTING_URL"),
			headers: { Authorization: envRef("EXISTING_TOKEN") },
			disabled: true,
		});
		expect(saved.mcpServers["user-server"]).toEqual({ disabled: true });

		await removeProjectMcpServer(root, "existing");
		saved = JSON.parse(await readFile(configPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(saved.mcpServers.existing).toBeUndefined();
		expect(saved.mcpServers.keep).toEqual({
			command: "node",
			args: ["server.js"],
		});
		await expect(removeProjectMcpServer(root, "missing")).rejects.toThrow(
			"not in project config",
		);
	});

	it("disables and removes MCP servers from their loaded config source", async () => {
		const root = await tempDir();
		await mkdir(path.join(root, ".git"));
		const home = await tempDir();
		const projectPath = path.join(root, ".backboard", "mcp.json");
		const userPath = path.join(home, ".backboard", "mcp.json");
		await writeJson(projectPath, {
			mcpServers: {
				shared: { command: "node", args: ["project.js"] },
				projectOnly: { command: "node", args: ["project-only.js"] },
			},
		});
		await writeJson(userPath, {
			mcpServers: {
				personal: { url: "https://personal.example.com/mcp" },
				shared: { env: { TOKEN: envRef("TOKEN") } },
			},
		});

		const config = await loadMcpConfig({ cwd: root, homeDir: home });
		const personal = expectServer(config.servers, "personal");
		await disableConfiguredMcpServer(root, "personal", personal.configSources);
		let project = JSON.parse(await readFile(projectPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		let user = JSON.parse(await readFile(userPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(project.mcpServers.personal).toBeUndefined();
		expect(user.mcpServers.personal).toEqual({
			url: "https://personal.example.com/mcp",
			disabled: true,
		});

		await removeConfiguredMcpServer(root, "personal", personal.configSources);
		user = JSON.parse(await readFile(userPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(user.mcpServers.personal).toBeUndefined();

		const shared = expectServer(config.servers, "shared");
		await removeConfiguredMcpServer(root, "shared", shared.configSources);
		project = JSON.parse(await readFile(projectPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		user = JSON.parse(await readFile(userPath, "utf8")) as {
			mcpServers: Record<string, unknown>;
		};
		expect(project.mcpServers.shared).toBeUndefined();
		expect(user.mcpServers.shared).toBeUndefined();
		expect(project.mcpServers.projectOnly).toEqual({
			command: "node",
			args: ["project-only.js"],
		});
	});

	it("routes MCP manager actions through the controller", async () => {
		const root = await tempDir();
		const saved: { name: string; server: unknown }[] = [];
		const activated: { name: string; server: unknown }[] = [];
		const registryServers: McpRegistryServer[] = [
			{
				name: "example",
				title: "Example MCP",
				category: "Development & Testing",
				description: "example desc",
				detail: "npx -y example-mcp",
				config: { command: "npx", args: ["-y", "example-mcp"] },
				requiredEnv: ["EXAMPLE_TOKEN"],
			},
			{
				name: "blocked",
				title: "Blocked MCP",
				category: "Development & Testing",
				description: "blocked desc",
				detail: "https://blocked.example.com/mcp",
				config: {
					type: "streamable-http",
					url: "https://blocked.example.com/mcp",
				},
				requiredEnv: [],
				disabledReason: "Blocked MCP is unavailable.",
			},
		];
		const controller = new McpController({
			cwd: root,
			listRegistryServers: async () => registryServers,
			saveProjectServer: async (_cwd, name, server) => {
				expect(_cwd).toBe(root);
				saved.push({ name, server });
				return path.join(root, ".backboard", "mcp.json");
			},
			activateServer: async (name, server) => {
				activated.push({ name, server });
				return {
					toolNames: [`mcp__${name}__tool`],
					warnings: [],
				};
			},
		});

		const items = await controller.listRegistryServers();
		expect(items).toEqual([
			{
				id: "example",
				title: "Example MCP",
				category: "Development & Testing",
				description: "example desc",
				detail: "npx -y example-mcp",
				requiredEnv: ["EXAMPLE_TOKEN"],
			},
			{
				id: "blocked",
				title: "Blocked MCP",
				category: "Development & Testing",
				description: "blocked desc",
				detail: "https://blocked.example.com/mcp",
				requiredEnv: [],
				disabledReason: "Blocked MCP is unavailable.",
			},
		]);

		const item = items[0];
		const disabledItem = items[1];
		if (!item) throw new Error("expected registry item");
		if (!disabledItem) throw new Error("expected disabled registry item");
		await expect(controller.addRegistryServer(disabledItem)).rejects.toThrow(
			"Blocked MCP is unavailable.",
		);
		const registryResult = await controller.addRegistryServer(item);
		const manualResult = await controller.addManualServer(
			"linear=https://linear.example.com/mcp",
		);

		expect(registryResult).toEqual({
			name: "example",
			title: "Example MCP",
			requiredEnv: ["EXAMPLE_TOKEN"],
			toolNames: ["mcp__example__tool"],
			warnings: [],
		});
		expect(manualResult).toEqual({
			name: "linear",
			title: "linear",
			requiredEnv: [],
			toolNames: ["mcp__linear__tool"],
			warnings: [],
		});
		expect(saved).toEqual([
			{
				name: "example",
				server: { command: "npx", args: ["-y", "example-mcp"] },
			},
			{
				name: "linear",
				server: { type: "http", url: "https://linear.example.com/mcp" },
			},
		]);
		expect(activated).toEqual(saved);
	});

	it("routes MCP server disable and remove through the controller", async () => {
		const root = await tempDir();
		const projectDisabled: string[] = [];
		const projectRemoved: string[] = [];
		const runtimeDisabled: string[] = [];
		const runtimeRemoved: string[] = [];
		const controller = new McpController({
			cwd: root,
			disableConfigServer: async (_cwd, name, sources) => {
				expect(_cwd).toBe(root);
				expect(sources).toEqual([{ scope: "project", path: "project-path" }]);
				projectDisabled.push(name);
				return path.join(root, ".backboard", "mcp.json");
			},
			removeConfigServer: async (_cwd, name, sources) => {
				expect(_cwd).toBe(root);
				expect(sources).toEqual([{ scope: "project", path: "project-path" }]);
				projectRemoved.push(name);
				return [path.join(root, ".backboard", "mcp.json")];
			},
			disableServer: async (name) => {
				runtimeDisabled.push(name);
				return { toolNames: [`mcp__${name}__tool`], warnings: [] };
			},
			removeServer: async (name) => {
				runtimeRemoved.push(name);
				return { toolNames: [`mcp__${name}__tool`], warnings: [] };
			},
		});
		const status: McpServerRuntimeStatus = {
			name: "canva",
			type: "http",
			configSources: [{ scope: "project", path: "project-path" }],
			status: "connected",
			toolNames: ["mcp__canva__tool"],
		};

		expect(await controller.disableServer(status)).toEqual({
			toolNames: ["mcp__canva__tool"],
			warnings: [],
		});
		expect(await controller.removeServer(status)).toEqual({
			toolNames: ["mcp__canva__tool"],
			warnings: [],
		});
		expect(projectDisabled).toEqual(["canva"]);
		expect(runtimeDisabled).toEqual(["canva"]);
		expect(projectRemoved).toEqual(["canva"]);
		expect(runtimeRemoved).toEqual(["canva"]);
	});

	it("re-authenticates connected MCP servers without duplicate tool names", async () => {
		const server = serverConfig({ name: "linear", type: "http" });
		const manager = new McpClientManager(
			{
				timeoutMs: 1_000,
				servers: [server],
				warnings: [],
			},
			await tempDir(),
		);
		let closeCount = 0;
		const connectCalls: boolean[] = [];
		Object.assign(manager as unknown as { connector: unknown }, {
			connector: {
				connect: async (
					_mcpServer: typeof server,
					_signal: AbortSignal,
					options: { interactiveAuth: boolean },
				) => {
					connectCalls.push(options.interactiveAuth);
					return {
						connection: {
							server,
							client: {} as Client,
							transport: {
								close: async () => {
									closeCount += 1;
								},
							},
							tools: new Map(),
							prompts: new Map(),
							resources: new Map(),
							updatedResourceUris: new Set(),
							subscribedResourceUris: new Set(),
							capabilities: { tools: {} },
						},
						tools: [
							{
								serverName: "linear",
								toolName: "search",
								description: "",
								inputSchema: { type: "object" },
								timeoutMs: 1_000,
								call: async () => ({ content: [] }),
							},
						],
						status: {
							name: "linear",
							type: "http",
							configSources: [],
							status: "connected",
							toolNames: [],
							capabilities: { tools: {} },
							promptNames: [],
							resourceUris: [],
							updatedResourceUris: [],
							subscribedResourceUris: [],
						},
						warnings: [],
					};
				},
			},
		});

		const first = await manager.authenticateServer(
			"linear",
			new AbortController().signal,
		);
		const second = await manager.authenticateServer(
			"linear",
			new AbortController().signal,
		);

		expect(first.tools.map((tool) => tool.registeredName)).toEqual([
			"mcp__linear__search",
		]);
		expect(second.tools.map((tool) => tool.registeredName)).toEqual([
			"mcp__linear__search",
		]);
		expect(closeCount).toBe(1);
		expect(connectCalls).toEqual([true, true]);
	});

	it("does not wait indefinitely for stuck MCP transports during shutdown", async () => {
		const server = serverConfig({ name: "stuck", type: "http" });
		const manager = new McpClientManager(
			{
				timeoutMs: 1_000,
				servers: [server],
				warnings: [],
			},
			await tempDir(),
			5,
		);
		let closeStarted = false;
		const connection: McpConnection = {
			server,
			client: {} as Client,
			transport: {
				close: async () => {
					closeStarted = true;
					await new Promise(() => {});
				},
			} as McpConnection["transport"],
			tools: new Map(),
			prompts: new Map(),
			resources: new Map(),
			updatedResourceUris: new Set(),
			subscribedResourceUris: new Set(),
			capabilities: {},
		};
		(
			manager as unknown as {
				connections: Map<string, McpConnection>;
			}
		).connections.set(server.name, connection);

		const startedAt = Date.now();
		await manager.close();

		expect(closeStarted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(250);
	});

	it("routes MCP prompts and resources through the controller", async () => {
		const root = await tempDir();
		const calls: string[] = [];
		const controller = new McpController({
			cwd: root,
			listPrompts: async (serverName) => {
				calls.push(`listPrompts:${serverName}`);
				return [
					{
						serverName,
						name: "summarize",
						description: "Summarize",
						arguments: [],
					},
				];
			},
			getPrompt: async (serverName, name, args) => {
				calls.push(`getPrompt:${serverName}:${name}:${args?.topic}`);
				return {
					messages: [
						{ role: "user", content: { type: "text", text: "Prompt" } },
					],
				};
			},
			listResources: async (serverName) => {
				calls.push(`listResources:${serverName}`);
				return [
					{
						serverName,
						uri: "file://notes",
						name: "Notes",
						description: "",
					},
				];
			},
			listResourceTemplates: async (serverName) => {
				calls.push(`listResourceTemplates:${serverName}`);
				return [
					{
						serverName,
						uriTemplate: "repo://{owner}/{repo}",
						name: "Repo",
						description: "",
					},
				];
			},
			readResource: async (serverName, uri) => {
				calls.push(`readResource:${serverName}:${uri}`);
				return { contents: [{ uri, text: "resource text" }] };
			},
			subscribeResource: async (serverName, uri) => {
				calls.push(`subscribeResource:${serverName}:${uri}`);
			},
			unsubscribeResource: async (serverName, uri) => {
				calls.push(`unsubscribeResource:${serverName}:${uri}`);
			},
		});
		const status: McpServerRuntimeStatus = {
			name: "docs",
			type: "http",
			configSources: [],
			status: "connected",
			toolNames: [],
		};
		const signal = new AbortController().signal;

		expect(await controller.listPrompts(status, signal)).toHaveLength(1);
		expect(
			await controller.getPrompt(status, "summarize", { topic: "mcp" }, signal),
		).toMatchObject({ messages: [{ role: "user" }] });
		expect(await controller.listResources(status, signal)).toHaveLength(1);
		expect(await controller.listResourceTemplates(status, signal)).toHaveLength(
			1,
		);
		expect(
			(await controller.readResource(status, "file://notes", signal))
				.contents[0]?.uri,
		).toBe("file://notes");
		expect(
			(
				await controller.readResourceTemplate(
					status,
					"repo://{owner}/{repo}{?branch}",
					{ owner: "octo", repo: "hello world", branch: "main" },
					signal,
				)
			).contents[0]?.uri,
		).toBe("repo://octo/hello%20world?branch=main");
		await controller.subscribeResource(status, "file://notes", signal);
		await controller.unsubscribeResource(status, "file://notes", signal);

		expect(calls).toEqual([
			"listPrompts:docs",
			"getPrompt:docs:summarize:mcp",
			"listResources:docs",
			"listResourceTemplates:docs",
			"readResource:docs:file://notes",
			"readResource:docs:repo://octo/hello%20world?branch=main",
			"subscribeResource:docs:file://notes",
			"unsubscribeResource:docs:file://notes",
		]);
	});

	it("browses only advertised MCP primitives", async () => {
		const calls: string[] = [];
		const controller = new McpController({
			cwd: await tempDir(),
			listPrompts: async (serverName) => {
				calls.push(`listPrompts:${serverName}`);
				return [{ serverName, name: "prompt", arguments: [] }];
			},
			listResources: async (serverName) => {
				calls.push(`listResources:${serverName}`);
				return [{ serverName, uri: "file://notes", name: "Notes" }];
			},
			listResourceTemplates: async (serverName) => {
				calls.push(`listResourceTemplates:${serverName}`);
				return [{ serverName, uriTemplate: "file://{name}", name: "File" }];
			},
		});
		const status: McpServerRuntimeStatus = {
			name: "docs",
			type: "http",
			configSources: [],
			status: "connected",
			toolNames: [],
			capabilities: { resources: {} },
		};

		const result = await controller.browsePrimitives(
			status,
			new AbortController().signal,
		);

		expect(result.prompts).toEqual([]);
		expect(result.resources.map((resource) => resource.uri)).toEqual([
			"file://notes",
		]);
		expect(result.templates.map((template) => template.uriTemplate)).toEqual([
			"file://{name}",
		]);
		expect(calls).toEqual(["listResources:docs", "listResourceTemplates:docs"]);
	});

	it("routes MCP prompt and resource refresh through the controller", async () => {
		const calls: string[] = [];
		const controller = new McpController({
			cwd: await tempDir(),
			refreshPrompts: async () => {
				calls.push("refreshPrompts");
				return {
					prompts: [
						{
							serverName: "docs",
							name: "new-prompt",
							description: "",
							arguments: [],
						},
					],
					removedPromptNames: ["docs.old-prompt"],
					warnings: ["prompt warning"],
				};
			},
			refreshResources: async () => {
				calls.push("refreshResources");
				return {
					resources: [
						{
							serverName: "docs",
							uri: "file://new",
							name: "New",
							description: "",
						},
					],
					removedResourceUris: ["docs.file://old"],
					updatedResourceUris: ["docs.file://changed"],
					warnings: ["resource warning"],
				};
			},
		});

		const result = await controller.refreshPromptAndResourceUpdates(
			new AbortController().signal,
		);

		expect(calls).toEqual(["refreshPrompts", "refreshResources"]);
		expect(result.prompts.map((prompt) => prompt.name)).toEqual(["new-prompt"]);
		expect(result.removedPromptNames).toEqual(["docs.old-prompt"]);
		expect(result.resources.map((resource) => resource.uri)).toEqual([
			"file://new",
		]);
		expect(result.removedResourceUris).toEqual(["docs.file://old"]);
		expect(result.updatedResourceUris).toEqual(["docs.file://changed"]);
		expect(result.warnings).toEqual(["prompt warning", "resource warning"]);
	});
});

describe("MCP tool names", () => {
	it("uses Claude-style namespacing with sanitized components", () => {
		expect(mcpFunctionName("my.server", "do thing")).toBe(
			"mcp__my_server__do_thing",
		);
	});

	it("caps long function names with a stable hash", () => {
		const name = mcpFunctionName("server".repeat(20), "tool".repeat(20));

		expect(name.length).toBeLessThanOrEqual(64);
		expect(name).toMatch(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+__[a-f0-9]{10}$/);
		expect(name).toBe(mcpFunctionName("server".repeat(20), "tool".repeat(20)));
	});
});

describe("McpToolAdapter", () => {
	it("exports MCP schemas and formats text plus structured results", async () => {
		const tool = new McpToolAdapter({
			registeredName: "mcp__linear__search",
			serverName: "linear",
			toolName: "search",
			trustAnnotations: true,
			description: "Search Linear issues",
			inputSchema: {
				$schema: "https://json-schema.org/draft/2020-12/schema",
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
			},
			annotations: { readOnlyHint: true },
			timeoutMs: 1_000,
			call: async (input: Record<string, unknown>) =>
				({
					content: [{ type: "text", text: `found ${input.query}` }],
					structuredContent: { count: 1 },
				}) as McpCallResult,
		});

		const schema = tool.toJSONSchema();
		expect(schema.function.name).toBe("mcp__linear__search");
		expect(schema.function.parameters).not.toHaveProperty("$schema");
		expect(tool.isReadOnly({})).toBe(true);
		expect(tool.isConcurrencySafe({})).toBe(true);

		const result = await tool.execute(
			{ query: "bug" },
			makeContext(new AbortController().signal),
		);

		expect(result.title).toBe("MCP linear.search");
		expect(result.forLLM).toContain("found bug");
		expect(result.forLLM).toContain('"count": 1');
	});

	it("treats unannotated and destructive MCP tools conservatively", () => {
		const unannotated = new McpToolAdapter(fakeDefinition({}));
		const destructive = new McpToolAdapter(
			fakeDefinition({ annotations: { destructiveHint: true } }),
		);

		expect(unannotated.isReadOnly({})).toBe(false);
		expect(unannotated.isConcurrencySafe({})).toBe(false);
		expect(destructive.isReadOnly({})).toBe(false);
		expect(destructive.isDestructive({})).toBe(true);
	});

	it("ignores readOnlyHint until the user's config trusts the server", () => {
		const claimed = { annotations: { readOnlyHint: true } };
		const untrusted = new McpToolAdapter(
			fakeDefinition({ ...claimed, trustAnnotations: false }),
		);
		const trusted = new McpToolAdapter(
			fakeDefinition({ ...claimed, trustAnnotations: true }),
		);

		expect(untrusted.isReadOnly({})).toBe(false);
		expect(trusted.isReadOnly({})).toBe(true);
		expect(untrusted.isConcurrencySafe({})).toBe(true);
	});

	it("hints at trustToolAnnotations only for untrusted read-only claims", () => {
		const claimed = { annotations: { readOnlyHint: true } };
		const untrusted = new McpToolAdapter(
			fakeDefinition({ ...claimed, trustAnnotations: false }),
		);
		const trusted = new McpToolAdapter(
			fakeDefinition({ ...claimed, trustAnnotations: true }),
		);
		const unannotated = new McpToolAdapter(
			fakeDefinition({ trustAnnotations: false }),
		);

		expect(untrusted.permissionHint({})).toContain("trustToolAnnotations");
		expect(untrusted.permissionHint({})).toContain("'server'");
		expect(trusted.permissionHint({})).toBeUndefined();
		expect(unannotated.permissionHint({})).toBeUndefined();
	});

	it("keeps a destructive tool out of read-only even when trusted", () => {
		const tool = new McpToolAdapter(
			fakeDefinition({
				annotations: { readOnlyHint: true, destructiveHint: true },
				trustAnnotations: true,
			}),
		);

		expect(tool.isReadOnly({})).toBe(false);
	});

	it("omits optional null MCP arguments without coercing schema-valid values", async () => {
		let calledInput: Record<string, unknown> | undefined;
		const tool = new McpToolAdapter({
			registeredName: "mcp__notion__notion-update-page",
			serverName: "notion",
			toolName: "notion-update-page",
			trustAnnotations: false,
			description: "Update a Notion page",
			inputSchema: {
				type: "object",
				properties: {
					page_id: { type: "string" },
					command: { type: "string" },
					new_str: { type: "string" },
					properties: { type: "object" },
					content: { type: "string" },
					content_updates: { type: "array" },
					required_value: { type: "string" },
					nullable_value: { type: ["string", "null"] },
					nullable_union: {
						anyOf: [{ type: "string" }, { type: "null" }],
					},
					nested: {
						type: "object",
						properties: {
							optional_nested: { type: "string" },
							required_nested: { type: "string" },
							kept_nested: { type: "integer" },
						},
						required: ["required_nested"],
					},
				},
				required: ["page_id", "command", "required_value"],
			},
			annotations: { readOnlyHint: false },
			timeoutMs: 1_000,
			call: async (input: Record<string, unknown>) => {
				calledInput = input;
				return { content: [] } as McpCallResult;
			},
		});

		await tool.execute(
			{
				page_id: "page-id",
				command: "replace_content",
				new_str: "new text",
				properties: null,
				content: null,
				content_updates: null,
				required_value: null,
				nullable_value: null,
				nullable_union: null,
				nested: {
					optional_nested: null,
					required_nested: null,
					kept_nested: 42,
				},
			},
			makeContext(new AbortController().signal),
		);

		expect(calledInput).toEqual({
			page_id: "page-id",
			command: "replace_content",
			new_str: "new text",
			required_value: null,
			nullable_value: null,
			nullable_union: null,
			nested: {
				required_nested: null,
				kept_nested: 42,
			},
		});
	});
});

describe("McpOAuthProvider", () => {
	it("uses localhost redirect URIs for all loopback OAuth providers", () => {
		for (const serverName of ["vercel", "linear", "notion"]) {
			const provider = new McpOAuthProvider(serverName, true);

			expect(provider.redirectUrl.startsWith("http://localhost:")).toBe(true);
			expect(provider.redirectUrl.endsWith("/oauth/callback")).toBe(true);
			expect(provider.clientMetadata.redirect_uris).toEqual([
				provider.redirectUrl,
			]);
		}
	});

	it("does not open a callback server for non-interactive auth", async () => {
		let listened = false;
		const provider = new McpOAuthProvider("non-interactive", false, {
			listenCallbackServer: async () => {
				listened = true;
				return { close: () => undefined };
			},
		});

		await expect(
			provider.waitForAuthorizationCode(new AbortController().signal, 1_000),
		).rejects.toThrow(McpAuthenticationRequiredError);
		expect(listened).toBe(false);
	});

	it("falls back to another localhost OAuth callback port when the preferred port is occupied", async () => {
		const attemptedPorts: number[] = [];
		const provider = new McpOAuthProvider("port-fallback-test", true, {
			listenCallbackServer: async (port) => {
				attemptedPorts.push(port);
				if (attemptedPorts.length === 1) {
					const err = new Error("busy") as NodeJS.ErrnoException;
					err.code = "EADDRINUSE";
					throw err;
				}
				return { close: () => undefined };
			},
		});
		const preferredPort = new URL(provider.redirectUrl).port;

		try {
			await provider.clientInformation();

			expect(provider.redirectUrl.startsWith("http://localhost:")).toBe(true);
			expect(new URL(provider.redirectUrl).port).not.toBe(preferredPort);
			expect(new URL(provider.redirectUrl).port).toBe(
				String(attemptedPorts[1]),
			);
			expect(provider.clientMetadata.redirect_uris).toEqual([
				provider.redirectUrl,
			]);
		} finally {
			provider.closeCallbackServer();
		}
	});

	it("captures the browser OAuth callback and persists client state in the configured store", async () => {
		const stateDir = await tempDir();
		let callback: RequestListener | undefined;
		const openedUrls: string[] = [];
		const provider = new McpOAuthProvider("oauth-smoke", true, {
			stateDir,
			openBrowser: async (url) => {
				openedUrls.push(url.toString());
			},
			listenCallbackServer: async (_port, handler) => {
				callback = handler;
				return { close: () => undefined };
			},
		});
		await provider.saveClientInformation({
			client_id: "client-id",
			client_secret: "client-secret",
		});
		await provider.saveTokens({
			access_token: "access-token",
			token_type: "Bearer",
		});

		const authorizationUrl = new URL("https://auth.example.test/authorize");
		await provider.redirectToAuthorization(authorizationUrl);
		const codePromise = provider.waitForAuthorizationCode(
			new AbortController().signal,
			1_000,
		);
		callback?.(
			requestFor(
				`/oauth/callback?code=auth-code&state=${encodeURIComponent(provider.state())}`,
			),
			responseFor(),
		);

		await expect(codePromise).resolves.toBe("auth-code");
		expect(openedUrls).toEqual([authorizationUrl.toString()]);
		expect(await provider.clientInformation()).toMatchObject({
			client_id: "client-id",
		});
		expect(await provider.tokens()).toMatchObject({
			access_token: "access-token",
		});
	});

	it("receives callbacks through the advertised localhost redirect URL", async () => {
		const provider = new McpOAuthProvider("oauth-localhost-smoke", true, {
			stateDir: await tempDir(),
		});
		await provider.clientInformation();

		const codePromise = provider.waitForAuthorizationCode(
			new AbortController().signal,
			1_000,
		);
		const callbackUrl = new URL(provider.redirectUrl);
		callbackUrl.searchParams.set("code", "loopback-code");
		callbackUrl.searchParams.set("state", provider.state());

		const response = await fetch(callbackUrl);

		expect(response.status).toBe(200);
		await expect(codePromise).resolves.toBe("loopback-code");
	});
});

describe("MCP tool listing", () => {
	it("follows tools/list pagination", async () => {
		const cursors: Array<string | undefined> = [];
		const client = {
			listTools: async (params?: { cursor?: string }) => {
				cursors.push(params?.cursor);
				if (!params?.cursor) {
					return {
						tools: [
							{
								name: "first",
								inputSchema: { type: "object" },
							},
						],
						nextCursor: "page-2",
					};
				}
				return {
					tools: [
						{
							name: "second",
							inputSchema: { type: "object" },
						},
					],
				};
			},
			callTool: async () => ({ content: [] }),
		} as unknown as Client;

		const tools = await listMcpServerToolDefinitions(
			serverConfig(),
			client,
			new AbortController().signal,
		);

		expect(cursors).toEqual([undefined, "page-2"]);
		expect(tools.map((tool) => tool.toolName)).toEqual(["first", "second"]);
	});

	it("skips tools/list when the server does not advertise tools", async () => {
		const client = {
			listTools: async () => {
				throw new Error("tools/list should not be called");
			},
		} as unknown as Client;

		const tools = await listMcpServerToolDefinitionsIfSupported(
			serverConfig(),
			client,
			{ prompts: {}, resources: {} },
			new AbortController().signal,
		);

		expect(tools).toEqual([]);
	});
});

describe("MCP prompt and resource listing", () => {
	it("follows prompts/list pagination and applies prompt filters", async () => {
		const cursors: Array<string | undefined> = [];
		const client = {
			listPrompts: async (params?: { cursor?: string }) => {
				cursors.push(params?.cursor);
				if (!params?.cursor) {
					return {
						prompts: [
							{
								name: "keep",
								title: "Keep",
								description: "Keep prompt",
								arguments: [{ name: "topic", required: true }],
								_meta: { source: "fixture" },
							},
						],
						nextCursor: "page-2",
					};
				}
				return {
					prompts: [{ name: "drop", description: "Drop prompt" }],
				};
			},
		} as unknown as Client;

		const prompts = await listMcpServerPromptDefinitions(
			serverConfig({ enabledPrompts: ["keep"] }),
			client,
			new AbortController().signal,
		);

		expect(cursors).toEqual([undefined, "page-2"]);
		expect(prompts).toEqual([
			{
				serverName: "paged",
				name: "keep",
				title: "Keep",
				description: "Keep prompt",
				arguments: [{ name: "topic", required: true }],
				_meta: { source: "fixture" },
			},
		]);
	});

	it("follows resources/list pagination and applies resource filters", async () => {
		const cursors: Array<string | undefined> = [];
		const client = {
			listResources: async (params?: { cursor?: string }) => {
				cursors.push(params?.cursor);
				if (!params?.cursor) {
					return {
						resources: [
							{
								uri: "file://keep",
								name: "Keep",
								title: "Keep Title",
								description: "Keep resource",
								mimeType: "text/plain",
								size: 12,
								annotations: { audience: ["assistant"] },
								_meta: { source: "fixture" },
							},
						],
						nextCursor: "page-2",
					};
				}
				return {
					resources: [{ uri: "file://drop", name: "Drop" }],
				};
			},
		} as unknown as Client;

		const resources = await listMcpServerResourceDefinitions(
			serverConfig({ disabledResources: ["file://drop"] }),
			client,
			new AbortController().signal,
		);

		expect(cursors).toEqual([undefined, "page-2"]);
		expect(resources).toEqual([
			{
				serverName: "paged",
				uri: "file://keep",
				name: "Keep",
				title: "Keep Title",
				description: "Keep resource",
				mimeType: "text/plain",
				size: 12,
				annotations: { audience: ["assistant"] },
				_meta: { source: "fixture" },
			},
		]);
	});

	it("follows resources/templates/list pagination and applies resource filters", async () => {
		const cursors: Array<string | undefined> = [];
		const client = {
			listResourceTemplates: async (params?: { cursor?: string }) => {
				cursors.push(params?.cursor);
				if (!params?.cursor) {
					return {
						resourceTemplates: [
							{
								uriTemplate: "repo://{owner}/{repo}",
								name: "Repo",
								title: "Repository",
								description: "Repository",
								mimeType: "application/json",
								annotations: { priority: 1 },
								_meta: { source: "fixture" },
							},
						],
						nextCursor: "page-2",
					};
				}
				return {
					resourceTemplates: [{ uriTemplate: "secret://{id}", name: "Secret" }],
				};
			},
		} as unknown as Client;

		const templates = await listMcpServerResourceTemplateDefinitions(
			serverConfig({ enabledResources: ["repo://{owner}/{repo}"] }),
			client,
			new AbortController().signal,
		);

		expect(cursors).toEqual([undefined, "page-2"]);
		expect(templates).toEqual([
			{
				serverName: "paged",
				uriTemplate: "repo://{owner}/{repo}",
				name: "Repo",
				title: "Repository",
				description: "Repository",
				mimeType: "application/json",
				annotations: { priority: 1 },
				_meta: { source: "fixture" },
			},
		]);
	});

	it("parses and expands standard MCP resource URI templates", () => {
		expect(
			resourceTemplateVariables("repo://{owner}/{repo}{?branch,q}"),
		).toEqual([
			{ name: "owner", required: true },
			{ name: "repo", required: true },
			{ name: "branch", required: false },
			{ name: "q", required: false },
		]);
	});
});

describe("MCP primitive manager", () => {
	it("does not probe unsupported prompt or resource capabilities", async () => {
		const calls: string[] = [];
		const connection = primitiveConnection({
			capabilities: { tools: {} },
			client: {
				listPrompts: async () => {
					calls.push("listPrompts");
					throw new Error("should not list prompts");
				},
				listResources: async () => {
					calls.push("listResources");
					throw new Error("should not list resources");
				},
				listResourceTemplates: async () => {
					calls.push("listResourceTemplates");
					throw new Error("should not list resource templates");
				},
			},
		});
		const manager = new McpPrimitiveManager({
			connections: new Map([[connection.server.name, connection]]),
			serverStatuses: new Map(),
		});
		const signal = new AbortController().signal;

		expect(await manager.listPrompts(connection.server.name, signal)).toEqual(
			[],
		);
		expect(await manager.listResources(connection.server.name, signal)).toEqual(
			[],
		);
		expect(
			await manager.listResourceTemplates(connection.server.name, signal),
		).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("tracks subscribed and updated MCP resource URIs in runtime status", async () => {
		const connection = primitiveConnection({
			capabilities: { resources: { subscribe: true } },
			client: {
				readResource: async ({ uri }) => ({
					contents: [{ uri, text: "notes" }],
				}),
				subscribeResource: async () => ({}),
				unsubscribeResource: async () => ({}),
			},
		});
		const status: McpServerRuntimeStatus = {
			name: connection.server.name,
			type: "http",
			configSources: [],
			status: "connected",
			toolNames: [],
			capabilities: { resources: { subscribe: true } },
			resourceUris: [],
			updatedResourceUris: [],
			subscribedResourceUris: [],
		};
		const manager = new McpPrimitiveManager({
			connections: new Map([[connection.server.name, connection]]),
			serverStatuses: new Map([[connection.server.name, status]]),
		});
		const signal = new AbortController().signal;

		await manager.subscribeResource(
			connection.server.name,
			"file://notes",
			signal,
		);
		manager.markResourceUpdated(connection.server.name, "file://notes");

		expect(status.subscribedResourceUris).toEqual(["file://notes"]);
		expect(status.updatedResourceUris).toEqual(["file://notes"]);

		await manager.readResource(connection.server.name, "file://notes", signal);

		expect(status.subscribedResourceUris).toEqual(["file://notes"]);
		expect(status.updatedResourceUris).toEqual([]);

		manager.markResourceUpdated(connection.server.name, "file://notes");
		await manager.unsubscribeResource(
			connection.server.name,
			"file://notes",
			signal,
		);

		expect(status.subscribedResourceUris).toEqual([]);
		expect(status.updatedResourceUris).toEqual([]);
	});
});

async function tempDir(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "q-cli-mcp-"));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function expectServer(
	servers: readonly McpServerConfig[],
	name: string,
): McpServerConfig {
	const server = servers.find((candidate) => candidate.name === name);
	if (!server) throw new Error(`missing server ${name}`);
	return server;
}

function fakeDefinition(
	overrides: Partial<McpToolDefinition>,
): McpToolDefinition {
	return {
		registeredName: "mcp__server__tool",
		serverName: "server",
		toolName: "tool",
		description: "",
		inputSchema: { type: "object" },
		trustAnnotations: false,
		timeoutMs: 1_000,
		call: async () => ({ content: [] }) as McpCallResult,
		...overrides,
	};
}

function listedDefinition(toolName: string): McpListedToolDefinition {
	return {
		serverName: "server",
		toolName,
		description: "",
		inputSchema: { type: "object" },
		trustAnnotations: false,
		timeoutMs: 1_000,
		call: async () => ({ content: [] }) as McpCallResult,
	};
}

function serverConfig(
	overrides: Partial<McpServerConfig> = {},
): McpServerConfig {
	return {
		name: "paged",
		type: "http",
		disabled: false,
		configSources: [],
		args: [],
		env: {},
		url: "https://example.com/mcp",
		headers: {},
		disabledTools: [],
		disabledPrompts: [],
		disabledResources: [],
		trustToolAnnotations: false,
		timeoutMs: 1_000,
		...overrides,
	};
}

function primitiveConnection(overrides: {
	capabilities?: McpConnection["capabilities"];
	client?: Partial<Client>;
	server?: Partial<McpServerConfig>;
}): McpConnection {
	return {
		server: serverConfig(overrides.server),
		client: overrides.client as Client,
		transport: { close: async () => undefined } as McpConnection["transport"],
		tools: new Map(),
		prompts: new Map(),
		resources: new Map(),
		updatedResourceUris: new Set(),
		subscribedResourceUris: new Set(),
		capabilities: overrides.capabilities ?? {},
	};
}

function requestFor(url: string): IncomingMessage {
	return { url } as IncomingMessage;
}

function responseFor(): ServerResponse {
	return {
		writeHead: () => undefined,
		end: () => undefined,
	} as unknown as ServerResponse;
}

function envRef(name: string): string {
	return `\${${name}}`;
}
