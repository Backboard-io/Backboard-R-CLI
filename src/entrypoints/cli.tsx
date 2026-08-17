#!/usr/bin/env bun
import { render } from "ink";
import { NO_CREDENTIALS_MESSAGE } from "../config/auth.ts";
import {
	APP_COMMAND_NAME,
	APP_DISPLAY_NAME,
	APP_VERSION,
} from "../config/branding.ts";
import { Config } from "../config/Config.ts";
import { parseFlags } from "../config/flags.ts";
import { AgentController } from "../core/agent/AgentController.ts";
import { BackgroundAgentSupervisor } from "../core/agent/BackgroundAgentSupervisor.ts";
import { discoverAgents } from "../core/agents/discovery.ts";
import { AttachmentManager } from "../core/attachments/AttachmentManager.ts";
import { sweepStaleClipboardImages } from "../core/attachments/clipboardImage.ts";
import {
	loginWithBackboardSso,
	logoutSavedCredentials,
} from "../core/auth/BackboardAuthSession.ts";
import { EventBus } from "../core/bus/EventBus.ts";
import { CheckpointManager } from "../core/checkpoints/CheckpointManager.ts";
import { CheckpointStore } from "../core/checkpoints/CheckpointStore.ts";
import {
	HookController,
	HookManagerController,
	loadHookConfig,
} from "../core/hooks/index.ts";
import { ProviderKeyController } from "../core/keys/ProviderKeyController.ts";
import {
	unreadableProviderKeys,
	upgradeProviderKeyFile,
} from "../core/keys/ProviderKeyStore.ts";
import { LspService, resolveLspFlags } from "../core/lsp/index.ts";
import {
	loadMcpConfig,
	McpClientManager,
	McpController,
	McpToolRegistrar,
} from "../core/mcp/index.ts";
import {
	buildPermissionContext,
	isKnownPermissionMode,
	PERMISSION_MODES,
} from "../core/permissions/index.ts";
import { ClientEventLog } from "../core/session/ClientEventLog.ts";
import { JsonEventStream } from "../core/session/JsonEventStream.ts";
import { ServerEventLog } from "../core/session/ServerEventLog.ts";
import { Session } from "../core/session/Session.ts";
import { SessionLifecycle } from "../core/session/SessionLifecycle.ts";
import {
	SessionStore,
	sessionPathsForRoot,
} from "../core/session/SessionStore.ts";
import { SkillController } from "../core/skills/SkillController.ts";
import { ToolRegistry } from "../core/tools/ToolRegistry.ts";
import { buildStartupEnvironmentPrompt } from "../prompts/system/startupEnvironment.ts";
import { BackboardError } from "../providers/backboard/errors.ts";
import { createAgentClient } from "../providers/createAgentClient.ts";
import { createDefaultTools } from "../tools/index.ts";
import { App } from "../ui/App.tsx";
import { AuthScreen } from "../ui/AuthScreen.tsx";
import { CLEAR_VISIBLE_SCREEN } from "../ui/hooks/ResizeStabilizer.constants.ts";
import {
	type InteractiveRenderConfig,
	resolveInteractiveRenderConfig,
} from "../ui/renderOptions.ts";
import { palette } from "../ui/theme/palette.ts";
import { ThemeProvider } from "../ui/theme/ThemeProvider.tsx";
import { detectTerminalBg } from "../ui/theme/terminalBg.ts";
import { createTheme, setTheme } from "../ui/theme/theme.ts";
import { errorMessage } from "../utils/errors.ts";
import { shortId } from "../utils/id.ts";
import { pluralize } from "../utils/string.ts";

const HELP = `${APP_DISPLAY_NAME} · coding agent

Usage:
  ${APP_COMMAND_NAME} [options]
  ${APP_COMMAND_NAME} login
  ${APP_COMMAND_NAME} logout

Options:
  --model <provider/model>   Model to use (e.g. openai/gpt-5.5)
  --format <default|json>    Output format (default: default)
  --thinking <level>         Thinking: off, low, medium, high, max, dynamic, or token budget
  --memory <mode>            Memory mode: off, on, auto, readonly
  --memory-profile <name>    Memory profile: default, code, coding
  --excluded-tools <names>   Comma-separated tool names to hide from the agent
  --profile <name>           Profile to load (default: coding)
  --cwd <path>               Working directory
  --print <prompt>           Run a single prompt non-interactively
  --permission-mode <mode>   manual | acceptEdits | auto (prompt only for risky) | bypass (default: manual)
  --lsp                      Enable language-server diagnostics for this run
  --fresh                    Create a new Backboard assistant/thread for this run (isolated)
  --login                    Sign in with Backboard
  --logout                   Remove saved Backboard credentials
  --help                     Show this help
  --version                  Show version
`;
async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const earlyFlags = parseFlags(argv);
	if (earlyFlags.help) {
		process.stdout.write(HELP);
		return;
	}
	if (earlyFlags.version) {
		process.stdout.write(`${APP_DISPLAY_NAME} ${APP_VERSION}\n`);
		return;
	}
	if (earlyFlags.login) {
		const didLogin = await runLoginCommand();
		if (!didLogin) process.exitCode = 1;
		return;
	}
	if (earlyFlags.logout) {
		await runLogoutCommand();
		return;
	}
	const interactiveRenderConfig = resolveInteractiveRenderConfig();

	let config: Config;
	while (true) {
		try {
			config = new Config({ argv });
			break;
		} catch (err) {
			const error = err instanceof Error ? err : String(err);
			if (shouldShowAuthScreen(error, earlyFlags)) {
				const didLogin = await runAuthScreen(interactiveRenderConfig);
				if (!didLogin) return;
				continue;
			}
			process.stderr.write(`${errorMessage(err)}\n`);
			process.exit(1);
		}
	}

	// Rewrites a pre-encryption keys.json in place. Best-effort: a read-only or
	// otherwise unwritable home must not stop the CLI from starting.
	await upgradeProviderKeyFile().catch(() => false);

	// A key that cannot be decrypted is dropped, which is indistinguishable from
	// never having saved one. Say so once at startup instead of letting the user
	// find out when a request fails.
	const unreadable = unreadableProviderKeys();
	if (unreadable.length > 0) {
		process.stderr.write(
			`Saved ${unreadable.join(", ")} ${pluralize(unreadable.length, "key")} could not be decrypted on this machine and ${pluralize(unreadable.length, "was", "were")} ignored. Re-add ${pluralize(unreadable.length, "it", "them")} with /keys.\n`,
		);
	}

	const sessionId = shortId("sess");
	const store = new SessionStore(sessionId, config.cwd);
	await store.init({
		sessionId,
		createdAt: new Date().toISOString(),
		cwd: config.cwd,
		model: config.modelString,
		profile: config.profile.name,
	});

	const bus = new EventBus();
	const clientLog = new ClientEventLog(sessionId, store.paths.clientLog);
	const serverLog = new ServerEventLog(sessionId, store.paths.serverLog);
	clientLog.attach(bus);
	// A crash mid-/undo leaves its write-ahead marker in the crashed session's
	// journal, and every launch mints a fresh session dir — so follow the
	// workspace-level pointer back to that journal and finish the restore.
	await CheckpointStore.recoverAbandonedRestore(store.paths.pendingUndo);
	const checkpoints = new CheckpointManager(bus, store.paths, config.cwd);
	// Hash the workspace in the background so the first shell command doesn't
	// pay the initial scan (seconds on very large trees).
	checkpoints.warmShellCapture(config.cwd);
	const jsonStream =
		config.format === "json" ? new JsonEventStream(sessionId) : null;
	jsonStream?.attach(bus);

	const session = new Session(sessionId);
	bus.emit({ type: "session:created", sessionId, threadId: session.threadId });

	const jsonPrompt =
		config.format === "json" && config.flags.print === undefined
			? await readPromptFromStdin()
			: undefined;
	if (
		config.format === "json" &&
		config.flags.print === undefined &&
		!jsonPrompt
	) {
		bus.emit({
			type: "run:error",
			error: "--format json requires --print or piped stdin",
		});
		await Promise.all([clientLog.flush(), serverLog.flush()]);
		process.exitCode = 1;
		return;
	}

	const client = createAgentClient(config, serverLog);
	const hookConfig = loadHookConfig(config.hookConfigPaths);
	const startupEnvironmentPrompt = await buildStartupEnvironmentPrompt(
		config.cwd,
	);
	const hookController = new HookController({
		hooks: hookConfig.hooks,
		bus,
		cwd: config.cwd,
		sessionId,
	});
	const hookManager = new HookManagerController(config.hookConfigPaths, {
		applyHooks: (hooks) => hookController.replaceHooks(hooks),
	});
	const mcpConfig = await loadMcpConfig({
		cwd: config.cwd,
		paths: config.mcpConfigPaths,
	});
	const mcpManager = new McpClientManager(mcpConfig, config.cwd);
	const mcp = await mcpManager.initialize(new AbortController().signal);
	// Both --print and --format json run through runHeadless, which has no UI to
	// answer an input:request. Anything that asks there would hang forever, so
	// the gate must know there is nobody to prompt.
	const headless = config.flags.print !== undefined || config.format === "json";
	const permissions = buildPermissionContext(
		config.cwd,
		config.flags.permissionMode,
		!headless,
	);
	// Must go through startupWarnings (rendered by App/headless), not a pre-render
	// bus.emit — the bus has no subscribers yet and doesn't replay.
	const permissionWarnings =
		config.flags.permissionMode !== undefined &&
		!isKnownPermissionMode(config.flags.permissionMode)
			? [
					`Unknown --permission-mode "${config.flags.permissionMode}"; using ${permissions.mode} mode. Valid: ${PERMISSION_MODES.join(", ")}.`,
				]
			: [];
	const renderWarnings = headless ? [] : interactiveRenderConfig.warnings;
	// MCP init warnings (unset env vars, skipped/failed servers) are deliberately
	// kept out of the startup surface — they cluttered every launch. Server status
	// is still inspectable via /mcp; only the noisy startup emission is dropped.
	const startupWarnings = [
		...hookConfig.warnings,
		...permissionWarnings,
		...renderWarnings,
	];
	for (const warning of startupWarnings) {
		bus.emit({ type: "system:warning", message: warning });
	}

	let registry: ToolRegistry;
	const lspFlags = resolveLspFlags();
	const lsp = new LspService({
		directory: config.cwd,
		flags: { ...lspFlags, enabled: config.flags.lsp ?? lspFlags.enabled },
		onWarning: (message) => {
			bus.emit({ type: "system:warning", message });
		},
	});
	const skillController = new SkillController({ cwd: config.cwd, bus });
	const backgroundSupervisor = new BackgroundAgentSupervisor(bus);
	const agentCatalog = await discoverAgents({ cwd: config.cwd });
	for (const warning of agentCatalog.warnings) {
		bus.emit({ type: "system:warning", message: warning });
	}
	registry = new ToolRegistry(
		createDefaultTools({
			client,
			config,
			hookController,
			lsp,
			checkpoints,
			getTools: () => registry.list(),
			skillController,
			getAgentCatalog: () => agentCatalog,
			// Headless runs exit after one prompt, so a backgrounded agent would be
			// cancelled before reporting — and the model would have been told a
			// report was coming. Withhold the supervisor so those spawns run inline.
			...(headless ? {} : { backgroundSupervisor }),
			// Lazy: mcpController is declared below (it needs `registry`), resolved at call time.
			getMcpRegistrar: () => mcpController,
		}),
	);
	const mcpToolRegistrar = new McpToolRegistrar(registry, bus);
	// Register the initially-configured servers' tools without re-emitting their
	// init warnings (see startupWarnings above). Servers added later at runtime
	// still surface their warnings through the normal register() path.
	mcpToolRegistrar.register({ ...mcp, warnings: [] });
	const syncMcpToolUpdates = async (signal: AbortSignal): Promise<void> => {
		const [tools, prompts, resources] = await Promise.all([
			mcpManager.refreshTools(signal),
			mcpManager.refreshPrompts(signal),
			mcpManager.refreshResources(signal),
		]);
		mcpToolRegistrar.applyRefresh(tools);
		mcpToolRegistrar.emitWarnings(prompts.warnings);
		mcpToolRegistrar.emitWarnings(resources.warnings);
	};
	const mcpController = new McpController({
		cwd: config.cwd,
		activateServer: async (name, server, signal) => {
			const controller = signal ?? new AbortController().signal;
			return mcpToolRegistrar.register(
				await mcpManager.addServer(name, server, controller),
			);
		},
		authenticateServer: async (name, signal) => {
			const controller = signal ?? new AbortController().signal;
			const previousToolNames =
				mcpManager.listServerStatuses().find((status) => status.name === name)
					?.toolNames ?? [];
			const result = await mcpManager.authenticateServer(name, controller);
			mcpToolRegistrar.unregister({
				toolNames: previousToolNames,
				warnings: [],
			});
			return mcpToolRegistrar.register(result);
		},
		disableServer: async (name) =>
			mcpToolRegistrar.unregister(await mcpManager.disableServer(name)),
		removeServer: async (name) =>
			mcpToolRegistrar.unregister(await mcpManager.removeServer(name)),
		listServerStatuses: () => mcpManager.listServerStatuses(),
		listPrompts: (name, signal) => mcpManager.listPrompts(name, signal),
		getPrompt: (serverName, name, args, signal) =>
			mcpManager.getPrompt(serverName, name, args, signal),
		listResources: (name, signal) => mcpManager.listResources(name, signal),
		listResourceTemplates: (name, signal) =>
			mcpManager.listResourceTemplates(name, signal),
		readResource: (name, uri, signal) =>
			mcpManager.readResource(name, uri, signal),
		subscribeResource: (name, uri, signal) =>
			mcpManager.subscribeResource(name, uri, signal),
		unsubscribeResource: (name, uri, signal) =>
			mcpManager.unsubscribeResource(name, uri, signal),
		refreshPrompts: (signal) => mcpManager.refreshPrompts(signal),
		refreshResources: (signal) => mcpManager.refreshResources(signal),
	});
	const sessionLifecycle = new SessionLifecycle(
		config,
		checkpoints,
		store,
		async (activeSessionId, paths) => {
			await Promise.all([
				clientLog.activate(activeSessionId, paths.clientLog).catch((error) =>
					bus.emit({
						type: "system:warning",
						message: `Failed to rotate the client session log: ${errorMessage(error)}`,
					}),
				),
				serverLog.activate(activeSessionId, paths.serverLog).catch((error) =>
					bus.emit({
						type: "system:warning",
						message: `Failed to rotate the server session log: ${errorMessage(error)}`,
					}),
				),
			]);
			jsonStream?.activate(activeSessionId);
			hookController.setSessionId(activeSessionId);
		},
	);
	await sessionLifecycle.initialize();
	const controller = new AgentController({
		config,
		bus,
		session,
		registry,
		client,
		skillController,
		hookController,
		lsp,
		checkpoints,
		backgroundSupervisor,
		getDurableSession: () => sessionLifecycle.current(),
		onThreadReplaced: (threadId) => sessionLifecycle.replaceThread(threadId),
		syncDynamicTools: syncMcpToolUpdates,
		startupEnvironmentPrompt,
		permissions,
		getTranscriptPath: () =>
			sessionPathsForRoot(sessionLifecycle.current().sessionRoot).clientLog,
	});
	// Deferred: the supervisor is built before the controller that consumes its
	// reports. Reports queue at "later" so they never preempt user input.
	backgroundSupervisor.setNotifier((report) => {
		void controller.submit(report, {
			emitUserMessage: false,
			priority: "later",
		});
	});

	const attachmentManager = new AttachmentManager();
	sweepStaleClipboardImages();
	const flush = async (): Promise<void> => {
		try {
			backgroundSupervisor.cancelAll();
			await controller.dispose();
			await lsp.shutdown();
			await mcpManager.close();
			await Promise.all([
				clientLog.flush(),
				serverLog.flush(),
				checkpoints.dispose(),
			]);
		} finally {
			await sessionLifecycle.dispose();
		}
	};

	// Fire SessionStart at init so it runs even for prompt-less sessions.
	await controller.start();

	if (config.flags.print !== undefined) {
		await runHeadless(
			controller,
			bus,
			config.flags.print,
			config.format,
			startupWarnings,
		);
		await flush();
		return;
	}

	if (config.format === "json") {
		await runHeadless(
			controller,
			bus,
			jsonPrompt ?? "",
			config.format,
			startupWarnings,
		);
		await flush();
		return;
	}

	// Detect the terminal background so surfaces elevate from it.
	const { hex: terminalBg } = await detectTerminalBg(palette.bg);
	const uiTheme = createTheme(terminalBg);
	setTheme(uiTheme);

	const app = (
		<ThemeProvider value={uiTheme}>
			<App
				config={config}
				bus={bus}
				controller={controller}
				skillController={skillController}
				mcpController={mcpController}
				hookManager={hookManager}
				lsp={lsp}
				checkpoints={checkpoints}
				client={client}
				attachments={attachmentManager}
				startupWarnings={startupWarnings}
				onLogin={(onDeviceCode) => loginWithBackboardSso({ onDeviceCode })}
				onLogout={logoutSavedCredentials}
				onNewSession={() => sessionLifecycle.startNew()}
				onResumeLocalSession={(sessionId) => sessionLifecycle.resume(sessionId)}
				onResumeRemoteSession={() => sessionLifecycle.startNew()}
				onExit={() => {
					controller.cancel({ clearQueue: true });
				}}
			/>
		</ThemeProvider>
	);
	const instance = render(app, {
		exitOnCtrlC: false,
		maxFps: interactiveRenderConfig.maxFps,
	});

	try {
		await instance.waitUntilExit();
	} finally {
		await flush();
	}
}

async function runAuthScreen(
	interactiveRenderConfig: InteractiveRenderConfig,
): Promise<boolean> {
	let didLogin = false;
	const { hex: terminalBg } = await detectTerminalBg(palette.bg);
	const uiTheme = createTheme(terminalBg);
	setTheme(uiTheme);
	const app = (
		<ThemeProvider value={uiTheme}>
			<AuthScreen
				keys={new ProviderKeyController()}
				warnings={interactiveRenderConfig.warnings}
				onKeySaved={() => {
					didLogin = true;
				}}
				onLogin={async (onDeviceCode) => {
					const message = await loginWithBackboardSso({ onDeviceCode });
					didLogin = true;
					return message;
				}}
			/>
		</ThemeProvider>
	);
	const instance = render(app, {
		exitOnCtrlC: true,
		maxFps: interactiveRenderConfig.maxFps,
	});
	await instance.waitUntilExit();
	if (didLogin) {
		instance.clear();
		clearTerminalScreen();
	}
	return didLogin;
}

function clearTerminalScreen(): void {
	if (!process.stdout.isTTY) return;
	process.stdout.write(CLEAR_VISIBLE_SCREEN);
}

function shouldShowAuthScreen(
	err: Error | string,
	flags: ReturnType<typeof parseFlags>,
): boolean {
	if (flags.print !== undefined || flags.format === "json") return false;
	if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

	const message = errorMessage(err);
	return (
		message.includes(NO_CREDENTIALS_MESSAGE) ||
		// Older saved configs still surface the pre-BYOK wording.
		message.includes("BACKBOARD_API_KEY is not set")
	);
}

async function runLoginCommand(): Promise<boolean> {
	process.stdout.write(`Starting ${APP_DISPLAY_NAME} login...\n`);
	try {
		const message = await loginWithBackboardSso({
			onDeviceCode: (response) => {
				process.stdout.write(
					[
						"\nTo sign in, open this URL on any device with a browser (code already filled in):",
						response.verification_uri_complete,
						"",
						`Or go to ${response.verification_uri} and enter code: ${response.user_code}`,
						"",
						"Waiting for approval...",
						"",
					].join("\n"),
				);
			},
		});
		process.stdout.write(`${message}\n`);
		return true;
	} catch (err) {
		process.stderr.write(`${errorMessage(err)}\n`);
		return false;
	}
}

async function runLogoutCommand(): Promise<void> {
	process.stdout.write(`${await logoutSavedCredentials()}\n`);
}

async function runHeadless(
	controller: AgentController,
	bus: EventBus,
	prompt: string,
	format: "default" | "json" = "default",
	startupWarnings: readonly string[] = [],
): Promise<void> {
	if (format === "default") {
		for (const warning of startupWarnings) {
			process.stderr.write(`warning: ${warning}\n`);
		}
		const streamedMessages = new Map<
			string,
			{ turnId: string; text: string }
		>();
		const openStreamTurns = new Set<string>();
		bus.on("assistant:delta", (event) => {
			const existing = streamedMessages.get(event.messageId);
			streamedMessages.set(event.messageId, {
				turnId: event.turnId,
				text: (existing?.text ?? "") + event.text,
			});
			openStreamTurns.add(event.turnId);
			process.stdout.write(event.text);
		});
		bus.on("assistant:message", (event) => {
			const streamedMessage = streamedMessages.get(event.messageId);
			if (!streamedMessage) {
				process.stdout.write(`${event.text}\n`);
				return;
			}
			streamedMessages.delete(event.messageId);
			const streamed = streamedMessage.text;
			if (event.text === streamed) return;
			if (event.text.startsWith(streamed)) {
				process.stdout.write(event.text.slice(streamed.length));
				return;
			}
			process.stdout.write(`\n${event.text}`);
		});
		bus.on("tool:requested", (event) => {
			if (!openStreamTurns.delete(event.turnId)) return;
			process.stdout.write("\n");
		});
		bus.on("turn:end", (event) => {
			for (const [key, streamedMessage] of streamedMessages) {
				if (streamedMessage.turnId === event.turnId) {
					streamedMessages.delete(key);
				}
			}
			if (!openStreamTurns.delete(event.turnId)) return;
			process.stdout.write("\n");
		});
		bus.on("run:error", (event) => {
			process.stderr.write(`error: ${event.error}\n`);
		});
		bus.on("system:warning", (event) => {
			process.stderr.write(`warning: ${event.message}\n`);
		});
	}
	const status = await controller.submit(prompt);
	if (status !== "completed") process.exitCode = 1;
}

async function readPromptFromStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";

	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
}

main().catch((err) => {
	const error = err instanceof Error ? err : String(err);
	process.stderr.write(`${formatFatalError(error)}\n`);
	process.exit(1);
});

function formatFatalError(err: Error | string): string {
	if (err instanceof BackboardError && err.status === 401) {
		return [
			"Backboard rejected BACKBOARD_API_KEY (HTTP 401).",
			"",
			"Check these things:",
			`- Run \`${APP_COMMAND_NAME} login\` again if the saved key is stale.`,
			"- BACKBOARD_API_KEY in your shell or `.env` overrides ~/.backboard/config.json.",
			"- BACKBOARD_API_URL matches where the key was created.",
			"",
			"For the normal Backboard app, use:",
			"BACKBOARD_API_URL=https://app.backboard.io/api",
		].join("\n");
	}

	return err instanceof Error ? (err.stack ?? err.message) : err;
}
