import { basename } from "node:path";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import type React from "react";
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { readBackboardConfig } from "../config/backboardConfig.ts";
import { APP_DISPLAY_NAME, APP_VERSION } from "../config/branding.ts";
import type { Config } from "../config/Config.ts";
import { formatModel } from "../config/defaults.ts";
import type { AgentController } from "../core/agent/AgentController.ts";
import type { AttachmentManager } from "../core/attachments/AttachmentManager.ts";
import { detectAttachmentPaste } from "../core/attachments/attachmentPaths.ts";
import { cleanupClipboardImages } from "../core/attachments/clipboardImage.ts";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "../core/attachments/constants.ts";
import type { BackboardDeviceCodeResponse } from "../core/auth/BackboardOAuth.ts";
import type { EventBus } from "../core/bus/EventBus.ts";
import type { CheckpointManager } from "../core/checkpoints/CheckpointManager.ts";
import type {
	CheckpointSummary,
	RestorePlan,
	RestoreResult,
} from "../core/checkpoints/journalTypes.ts";
import { type ContextReport, formatTokens } from "../core/context/index.ts";
import type {
	AddHookInput,
	HookEventName,
	HookEventSummary,
	HookManagerController,
	HookManagerSnapshot,
	LoadedHook,
} from "../core/hooks/index.ts";
import { ProviderKeyController } from "../core/keys/ProviderKeyController.ts";
import type { LspService } from "../core/lsp/index.ts";
import type {
	McpAddResult,
	McpController,
	McpPromptDefinition,
	McpRegistryItem,
	McpResourceDefinition,
	McpResourceTemplateDefinition,
	McpServerRuntimeStatus,
} from "../core/mcp/index.ts";
import {
	formatMcpPromptForUser,
	formatMcpResourceForUser,
	resourceTemplateVariables,
} from "../core/mcp/index.ts";
import { lookupResumeEntry } from "../core/session/ResumeIndex.ts";
import type {
	SkillController,
	SkillInstallTarget,
	SkillPickerItem,
	SkillPickerTab,
} from "../core/skills/SkillController.ts";
import { checkForCliUpdate } from "../core/update/updateCheck.ts";
import type { AgentClient } from "../providers/AgentClient.ts";
import { fetchModels } from "../providers/backboard/models.ts";
import type {
	BackboardThread,
	ModelInfo,
} from "../providers/backboard/types.ts";
import { errorMessage } from "../utils/errors.ts";
import { pluralize } from "../utils/string.ts";
import {
	canRunCommandAfterSessionEnd,
	HELP_TEXT,
	parseCommand,
} from "./commands/index.ts";
import { AskUserPrompt } from "./components/AskUserPrompt.tsx";
import { ContextPanel } from "./components/ContextPanel.tsx";
import { HookAddForm } from "./components/HookAddForm.tsx";
import { HookDetails } from "./components/HookDetails.tsx";
import {
	type HookEventSelection,
	HookEventSelector,
} from "./components/HookEventSelector.tsx";
import {
	type HookManagerSelection,
	HookManagerSelector,
} from "./components/HookManagerSelector.tsx";
import { HookMatcherSelector } from "./components/HookMatcherSelector.tsx";
import { ManualMcpInput } from "./components/ManualMCPInput.tsx";
import {
	type McpArgumentField,
	McpArgumentInput,
} from "./components/MCPArgumentInput.tsx";
import {
	type McpManagerSelection,
	McpManagerSelector,
} from "./components/MCPManagerSelector.tsx";
import {
	type McpPrimitiveSelection,
	McpPrimitiveSelector,
} from "./components/MCPPrimitiveSelector.tsx";
import { McpRegistrySelector } from "./components/MCPRegistrySelector.tsx";
import { McpServerActions } from "./components/MCPServerActions.tsx";
import {
	type MemoryChoice,
	MemorySelector,
} from "./components/MemorySelector.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ModelSelector } from "./components/ModelSelector.tsx";
import {
	emptyPromptHistoryState,
	PromptInput,
} from "./components/PromptInput.tsx";
import { ProviderKeyManager } from "./components/ProviderKeyManager.tsx";
import {
	FileSelect,
	type RestoreChoice,
	RestoreOptions,
	RewindSelector,
} from "./components/RewindSelector.tsx";
import { SessionsSelector } from "./components/SessionsSelector.tsx";
import {
	type SettingsOpenId,
	SettingsPanel,
	type SettingsState,
	type SettingsToggleId,
} from "./components/SettingsPanel.tsx";
import { SkillActions } from "./components/SkillActions.tsx";
import { SkillsSelector } from "./components/SkillsSelector.tsx";
import { Spinner } from "./components/Spinner.tsx";
import { StaticTranscript } from "./components/StaticTranscript.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import {
	modelUsesAutomaticThinkingOnly,
	type ThinkingChoice,
	ThinkingSelector,
} from "./components/ThinkingSelector.tsx";
import {
	TodoPanel,
	todoPanelDisplayForTerminalHeight,
} from "./components/TodoPanel.tsx";
import {
	COMPACT_TODO_TRANSCRIPT_TAIL_ITEMS,
	TODO_TRANSCRIPT_TAIL_ITEMS,
} from "./components/TranscriptLayout.constants.ts";
import { compactLiveTranscriptItems } from "./components/TranscriptLayout.ts";
import { CLEAR_VISIBLE_SCREEN } from "./hooks/ResizeStabilizer.constants.ts";
import { TerminalSizeProvider } from "./hooks/TerminalSizeContext.tsx";
import { useAgent } from "./hooks/useAgent.ts";
import { useLspToggle } from "./hooks/useLspToggle.ts";
import { useResizeStabilizer } from "./hooks/useResizeStabilizer.ts";
import {
	useStableStaticBanner,
	useStableTranscriptLayout,
} from "./hooks/useStableTranscriptLayout.ts";
import { useStartupPickerPreload } from "./hooks/useStartupPickerPreload.ts";
import { VerboseProvider } from "./hooks/VerboseContext.tsx";
import type { PromptHistoryState, QueuedPromptItem } from "./input/types.ts";
import { playCompletionNotification } from "./notify.ts";
import { theme } from "./theme/theme.ts";
import { composeSubmissionWithNotes } from "./utils/modelNotes.ts";
import {
	refreshCredentials as refreshClientCredentials,
	shouldAdoptPersistedModel,
} from "./utils/refreshCredentials.ts";
import {
	activateResumeTarget,
	hydrateResumeTarget,
	isAlreadyActiveResume,
	type ResumeTarget,
	resolveResumeTarget,
} from "./utils/resumeSession.ts";
import { shouldReprintOnSettingsExit } from "./utils/settingsReprint.ts";
import { startNewSession } from "./utils/startNewSession.ts";

interface Props {
	config: Config;
	bus: EventBus;
	controller: AgentController;
	skillController: SkillController;
	mcpController: McpController;
	hookManager: HookManagerController;
	lsp: LspService;
	client: AgentClient;
	/** File checkpoint engine for /undo, /redo, and /rewind; optional until wired in the entrypoint. */
	checkpoints?: CheckpointManager;
	attachments: AttachmentManager;
	startupWarnings: readonly string[];
	initialResumeTarget?: ResumeTarget;
	onLogin: (
		onDeviceCode?: (response: BackboardDeviceCodeResponse) => void,
	) => Promise<string>;
	onLogout: () => Promise<string>;
	onNewSession: () => Promise<void>;
	onResumeLocalSession: (sessionId: string) => Promise<void>;
	onResumeRemoteSession: () => Promise<void>;
	getActiveSessionId: () => string;
	onExit: () => void;
}

type Mode =
	| "normal"
	| "loading"
	| "model"
	| "thinking"
	| "memory"
	| "settings"
	| "skills"
	| "skill-actions"
	| "sessions"
	| "hooks"
	| "hooks-event"
	| "hooks-matcher"
	| "hook-detail"
	| "hooks-add"
	| "keys"
	| "context"
	| "mcp"
	| "mcp-server"
	| "mcp-primitives"
	| "mcp-arguments"
	| "mcp-registry"
	| "mcp-manual"
	| "rewind"
	| "rewind-confirm"
	| "rewind-files";

type RestoreVerb = "undo" | "redo" | "rewind";

interface PendingRestore {
	plan: RestorePlan;
	summary: CheckpointSummary | null;
	verb: RestoreVerb;
	/** Paths kept for a cherry-picked restore (the file-selection step). */
	included: Set<string>;
}

type PendingMcpArgumentSelection =
	| { type: "prompt"; prompt: McpPromptDefinition }
	| { type: "template"; template: McpResourceTemplateDefinition };

const DOUBLE_CTRL_C_MS = 1500;

function transcriptTailItemsForLayout({
	running,
	staticOnly,
	hasTodos,
	compactTodos,
}: {
	running: boolean;
	staticOnly: boolean;
	hasTodos: boolean;
	compactTodos: boolean;
}): number | undefined {
	if (running) return 0;
	if (staticOnly) return 0;
	if (!hasTodos) return undefined;
	return compactTodos
		? COMPACT_TODO_TRANSCRIPT_TAIL_ITEMS
		: TODO_TRANSCRIPT_TAIL_ITEMS;
}

export function App({
	config,
	bus,
	controller,
	skillController,
	mcpController,
	hookManager,
	lsp,
	client,
	checkpoints,
	attachments,
	startupWarnings,
	initialResumeTarget,
	onLogin,
	onLogout,
	onNewSession,
	onResumeLocalSession,
	onResumeRemoteSession,
	getActiveSessionId,
	onExit,
}: Props): React.ReactElement {
	const app = useApp();
	const agent = useAgent(controller, bus, config.modelString, startupWarnings);
	const [showBanner, setShowBanner] = useState(true);
	const [queuedPrompts, setQueuedPrompts] = useState<QueuedPromptItem[]>([]);
	const [promptHistory, setPromptHistory] = useState<PromptHistoryState>(
		emptyPromptHistoryState,
	);
	const nextQueuedPromptId = useRef(0);
	// Live values so a banner re-print (/new, /clear, resize) shows the current model.
	const banner = {
		status: agent.state.status,
		model: agent.state.model,
		cwd: config.cwd,
		usage: agent.state.usage,
	};
	const [mode, setMode] = useState<Mode>("normal");
	const initialResumeApplied = useRef(false);
	useEffect(() => {
		if (!initialResumeTarget || initialResumeApplied.current) return;
		initialResumeApplied.current = true;
		agent.hydrateTranscript(initialResumeTarget.messages);
		for (const warning of startupWarnings) {
			agent.notice(warning, "info");
		}
		setShowBanner(false);
		agent.notice(`Resumed session: ${initialResumeTarget.displayTitle}`);
	}, [agent, initialResumeTarget, startupWarnings]);
	const [loadingLabel, setLoadingLabel] = useState("Loading");
	const [models, setModels] = useState<ModelInfo[]>([]);
	const refreshCredentials = useCallback((): void => {
		const wasExpert = config.isExpertModeEnabled;
		refreshClientCredentials(config, client);
		const persistedModel = readBackboardConfig().model;
		if (
			shouldAdoptPersistedModel(
				config.flags.model,
				config.modelString,
				persistedModel,
			)
		) {
			config.setModel(persistedModel);
			agent.setModelLabel(formatModel(persistedModel));
		} else if (!config.hasBackendForCurrentModel) {
			agent.notice(
				"Choose another model because the selected provider is no longer enabled.",
				"warning",
			);
			setMode("model");
		}
		if (wasExpert && !config.isExpertModeEnabled) {
			agent.notice(
				"Expert mode is off: its model's provider key is no longer enabled.",
				"warning",
			);
		}
		setModels([]);
	}, [agent, config, client]);
	// Every `/providers` change re-reads credentials into the live Config, so the
	// next request routes through the new key set without a restart. The model
	// list is dropped because which models exist depends on those keys.
	const providerKeys = useMemo(
		() =>
			new ProviderKeyController({
				onChange: refreshCredentials,
			}),
		[refreshCredentials],
	);
	const [pendingModel, setPendingModel] = useState<ModelInfo | null>(null);
	// One picker serves `/model` and expert mode; this says which one asked.
	const [modelPickerTarget, setModelPickerTarget] = useState<"main" | "expert">(
		"main",
	);
	const [contextReport, setContextReport] = useState<ContextReport | null>(
		null,
	);
	const [skillTabs, setSkillTabs] = useState<SkillPickerTab[]>([]);
	const [selectedSkillItem, setSelectedSkillItem] =
		useState<SkillPickerItem | null>(null);
	const [sessionThreads, setSessionThreads] = useState<BackboardThread[]>([]);
	const [hookSnapshot, setHookSnapshot] = useState<HookManagerSnapshot | null>(
		null,
	);
	const [selectedHookEvent, setSelectedHookEvent] =
		useState<HookEventSummary | null>(null);
	const [pendingHookMatcher, setPendingHookMatcher] = useState<string | null>(
		null,
	);
	const [selectedHookMatcherHooks, setSelectedHookMatcherHooks] = useState<
		LoadedHook[]
	>([]);
	const [selectedHook, setSelectedHook] = useState<LoadedHook | null>(null);
	const [addContext, setAddContext] = useState<{
		event: HookEventName;
		initialMatcher?: string;
	} | null>(null);
	const [addToolNames, setAddToolNames] = useState<string[]>([]);
	const [mcpServers, setMcpServers] = useState<McpRegistryItem[]>([]);
	const [mcpServerStatuses, setMcpServerStatuses] = useState<
		McpServerRuntimeStatus[]
	>(() => mcpController.listServerStatuses());
	const [selectedMcpServer, setSelectedMcpServer] =
		useState<McpServerRuntimeStatus | null>(null);
	const [mcpPrompts, setMcpPrompts] = useState<McpPromptDefinition[]>([]);
	const [mcpResources, setMcpResources] = useState<McpResourceDefinition[]>([]);
	const [mcpResourceTemplates, setMcpResourceTemplates] = useState<
		McpResourceTemplateDefinition[]
	>([]);
	const [pendingMcpArguments, setPendingMcpArguments] =
		useState<PendingMcpArgumentSelection | null>(null);
	const [rewindCheckpoints, setRewindCheckpoints] = useState<
		CheckpointSummary[]
	>([]);
	const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(
		null,
	);
	// Notes the model must see on its next turn (e.g. "files were reverted by
	// /undo"). Prepended as a <system-reminder> to the next submitted prompt so
	// the model does not trust stale tool results; the UI transcript still shows
	// only what the user typed.
	const pendingModelNotes = useRef<string[]>([]);
	const [lastCtrlC, setLastCtrlC] = useState(0);
	const [sessionEnded, setSessionEnded] = useState(false);
	const [verbose, setVerbose] = useState(config.isVerbose);
	// Bumped on each /verbose toggle so already-printed <Static> tool rows
	// reprint at the new verbosity, the same way a resize forces a reprint.
	const [verboseEpoch, setVerboseEpoch] = useState(0);
	const [, forceSettingsRender] = useReducer((count: number) => count + 1, 0);
	const verboseAtSettingsOpen = useRef(config.isVerbose);
	const [memoryReturnsToSettings, setMemoryReturnsToSettings] = useState(false);
	const { toggleLsp, lspPending } = useLspToggle(lsp, agent.notice);
	useStartupPickerPreload(client, skillController);
	const terminalSize = useWindowSize();
	const { stdout, write } = useStdout();
	/**
	 * Runs compression and hands the resulting handoff to the next turn through
	 * the same pending-notes channel /undo uses: the model receives it as
	 * context, the visible transcript stays clean.
	 */
	const runCompaction = useCallback(
		async (trigger: "manual" | "auto"): Promise<void> => {
			setLoadingLabel(
				trigger === "auto"
					? "Context full — compressing"
					: "Compressing conversation",
			);
			setMode("loading");
			try {
				const result = await controller.compact();
				pendingModelNotes.current.push(result.resumeContext);
				// The transcript is dropped and the screen redrawn, so what is on
				// screen matches what the model now holds - a scrollback full of
				// history the model no longer has is the more confusing state.
				// Nothing is lost: the full run is still on disk, and the handoff
				// names that file so the agent can read back into it.
				agent.clear();
				if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
				setShowBanner(true);
				agent.notice(
					`Compressed ${result.messagesCompacted} messages · ${formatTokens(
						result.beforeTokens,
					)} → ~${formatTokens(result.afterTokens)} tokens · kept the last ${
						result.verbatimKept
					} exchanges verbatim${
						result.transcriptPath
							? `\nFull transcript: ${result.transcriptPath}`
							: ""
					}`,
				);
			} catch (err) {
				agent.notice(`Compression failed: ${errorMessage(err)}`, "error");
			} finally {
				setMode("normal");
			}
		},
		[agent, controller, stdout, write],
	);

	const openContextPanel = useCallback((): void => {
		setContextReport(
			controller.contextReport(client.sourceFor?.(config.model) ?? "backboard"),
		);
		setMode("context");
	}, [client, config, controller]);

	const submitPrompt = useCallback(
		(
			text: string,
			options: {
				steer?: boolean;
				onStart?: () => void;
				attachmentIds?: string[];
			} = {},
		) => {
			let finalText = text;
			let ids = options.attachmentIds ?? [];
			const detected = detectAttachmentPaste(finalText);
			if (detected.kind === "attachments" && detected.accepted.length > 0) {
				const budget = MAX_ATTACHMENTS_PER_MESSAGE - ids.length;
				const accepted = detected.accepted.slice(0, Math.max(0, budget));
				if (accepted.length > 0) {
					if (accepted.length < detected.accepted.length) {
						agent.notice(
							`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments — skipped ${detected.accepted.length - accepted.length} file(s)`,
							"error",
						);
					}
					ids = [...ids, ...attachments.add(accepted).map((item) => item.id)];
					finalText = detected.remainingText;
				}
			}
			const paths = ids.length > 0 ? attachments.consume(ids) : [];
			// Restore notes (files reverted by /undo) the model must see on its
			// next turn: prefixed to what the model receives, while the transcript
			// shows only the user's own words.

			const composed = composeSubmissionWithNotes(
				finalText,
				pendingModelNotes.current,
				{ steer: options.steer ?? false },
			);
			if (composed.consumedNotes) pendingModelNotes.current = [];
			if (composed.emitTranscriptText !== null) {
				bus.emit({ type: "user:message", text: composed.emitTranscriptText });
			}
			const submitOptions = {
				onStart: options.onStart,
				attachmentFilePaths: paths.length > 0 ? paths : undefined,
				displayContent:
					finalText ||
					(paths.length > 0
						? `[Attached: ${paths.map((path) => basename(path)).join(", ")}]`
						: "[Continued after restoring files]"),
			};
			const run = options.steer
				? controller.steer(composed.modelText, submitOptions)
				: controller.submit(composed.modelText, {
						...submitOptions,
						emitUserMessage: composed.emitUserMessage,
					});
			void run
				.then((status) => {
					if (status === "completed" && config.isNotifyEnabled) {
						playCompletionNotification(write);
					}
					// Checked only here, once the turn is fully done: compressing
					// mid-turn would reset the thread out from under a tool loop
					// still submitting results into it.
					if (status === "completed" && controller.needsCompaction()) {
						void runCompaction("auto");
					}
				})
				.catch(() => {
					// Errors are already surfaced as run:error events.
				})
				.finally(() => cleanupClipboardImages(paths));
		},
		[agent, attachments, bus, config, controller, runCompaction, write],
	);
	const refreshSkillTabs = useCallback(async (): Promise<void> => {
		setSkillTabs(await skillController.listSkillTabs());
	}, [skillController]);
	const loadSkillFromActions = useCallback(
		async (
			item: SkillPickerItem,
			signal: AbortSignal,
			target?: SkillInstallTarget,
		) => {
			const result = await skillController.selectSkill(item, signal, target);
			agent.notice(
				result.action === "deactivated"
					? `Unloaded skill: ${result.selectedName}`
					: `Loaded skill: ${result.selectedName}`,
			);
			await refreshSkillTabs();
			setMode("skills");
		},
		[agent, refreshSkillTabs, skillController],
	);
	const unloadSkillFromActions = useCallback(
		async (item: SkillPickerItem) => {
			const result = skillController.deactivateSkill(item.name);
			agent.notice(`Unloaded skill: ${result.selectedName}`);
			await refreshSkillTabs();
			setMode("skills");
		},
		[agent, refreshSkillTabs, skillController],
	);
	const removeSkillFromActions = useCallback(
		async (item: SkillPickerItem) => {
			await skillController.removeSkill(item);
			agent.notice(`Removed skill: ${item.name}`);
			await refreshSkillTabs();
			setMode("skills");
		},
		[agent, refreshSkillTabs, skillController],
	);
	const openModelPicker = useCallback(
		(target: "main" | "expert") => {
			setModelPickerTarget(target);
			setLoadingLabel("Loading models");
			setMode("loading");
			void fetchModels(client)
				.then((result) => {
					setModels(result);
					setMode("model");
				})
				.catch((err) => {
					agent.notice(`Failed to load models: ${errorMessage(err)}`, "error");
					setMode(target === "expert" ? "settings" : "normal");
				});
		},
		[agent, client],
	);
	const openModelSelector = useCallback(() => {
		openModelPicker("main");
	}, [openModelPicker]);
	const openSkillsSelector = useCallback(() => {
		setLoadingLabel("Loading skills");
		setMode("loading");
		void skillController
			.listSkillTabs()
			.then((result) => {
				setSkillTabs(result);
				setMode("skills");
			})
			.catch((err) => {
				agent.notice(`Failed to load skills: ${errorMessage(err)}`, "error");
				setMode("normal");
			});
	}, [agent, skillController]);
	const openSessionsSelector = useCallback(() => {
		setLoadingLabel("Loading sessions");
		setMode("loading");
		void client
			.listThreads()
			.then((threads) => {
				setSessionThreads(
					threads.filter((thread) => thread.thread_id !== controller.threadId),
				);
				setMode("sessions");
			})
			.catch((err) => {
				agent.notice(`Failed to load sessions: ${errorMessage(err)}`, "error");
				setMode("normal");
			});
	}, [agent, client, controller]);
	const openHookManager = useCallback(() => {
		const snapshot = hookManager.snapshot();
		setHookSnapshot(snapshot);
		for (const warning of snapshot.warnings) {
			agent.notice(warning, "error");
		}
		setMode("hooks");
	}, [agent, hookManager]);
	const startAddHook = useCallback(
		(event: HookEventName, matcher?: string) => {
			setAddContext({ event, initialMatcher: matcher });
			setAddToolNames(controller.listToolNames());
			setMode("hooks-add");
		},
		[controller],
	);
	const addHook = useCallback(
		async (input: AddHookInput) => {
			const snapshot = await hookManager.addHook(input);
			setHookSnapshot(snapshot);
			const summary = snapshot.events.find(
				(event) => event.event === input.event,
			);
			if (summary) {
				setSelectedHookEvent(summary);
				setMode("hooks-event");
			} else {
				setMode("hooks");
			}
			agent.notice("Hook added.", "info");
		},
		[agent, hookManager],
	);
	const selectHookManagerItem = useCallback(
		(selection: HookManagerSelection) => {
			setSelectedHookEvent(selection.event);
			setMode("hooks-event");
		},
		[],
	);
	const selectHookEventItem = useCallback((selection: HookEventSelection) => {
		setPendingHookMatcher(selection.matcher);
		setSelectedHookMatcherHooks(selection.hooks);
		setMode("hooks-matcher");
	}, []);
	const viewHookDetails = useCallback((hook: LoadedHook) => {
		setSelectedHook(hook);
		setMode("hook-detail");
	}, []);
	const removeHook = useCallback(
		async (hook: LoadedHook) => {
			const snapshot = await hookManager.removeHook(hook);
			setHookSnapshot(snapshot);
			setSelectedHook(null);
			const matcherKey = hook.matcher ?? "*";
			const remaining = snapshot.hooks.filter(
				(candidate) =>
					candidate.event === hook.event &&
					(candidate.matcher ?? "*") === matcherKey,
			);
			if (remaining.length === 0) {
				setMode("hooks-event");
			} else {
				setSelectedHookMatcherHooks(remaining);
				setMode("hooks-matcher");
			}
			agent.notice("Hook removed.", "info");
		},
		[agent, hookManager],
	);
	const noticeMcpAdded = useCallback(
		(result: McpAddResult) => {
			const envNote =
				result.requiredEnv.length > 0
					? ` Required env: ${result.requiredEnv.join(", ")}.`
					: "";
			const toolsNote =
				result.toolNames.length > 0
					? ` Loaded ${result.toolNames.length} ${pluralize(result.toolNames.length, "tool")}.`
					: " No tools loaded in this session.";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Added MCP server: ${result.title}.${toolsNote}${envNote}${warningNote}`,
			);
		},
		[agent],
	);
	const refreshMcpStatuses = useCallback((): McpServerRuntimeStatus[] => {
		const statuses = mcpController.listServerStatuses();
		setMcpServerStatuses(statuses);
		return statuses;
	}, [mcpController]);
	const openMcpServer = useCallback(
		(serverName: string): boolean => {
			const statuses = refreshMcpStatuses();
			const status = statuses.find(
				(candidate) => candidate.name === serverName,
			);
			if (!status) return false;
			setSelectedMcpServer(status);
			setMode("mcp-server");
			return true;
		},
		[refreshMcpStatuses],
	);
	const addMcpServer = useCallback(
		async (server: McpRegistryItem, signal: AbortSignal) => {
			const result = await mcpController.addRegistryServer(server, signal);
			noticeMcpAdded(result);
			if (!openMcpServer(result.name)) {
				setMode("mcp");
			}
		},
		[mcpController, noticeMcpAdded, openMcpServer],
	);
	const openMcpRegistry = useCallback(() => {
		setLoadingLabel("Loading MCP catalog");
		setMode("loading");
		void mcpController
			.listRegistryServers()
			.then((result) => {
				setMcpServers(result);
				setMode("mcp-registry");
			})
			.catch((err) => {
				agent.notice(
					`Failed to load MCP catalog: ${errorMessage(err)}`,
					"error",
				);
				setMode("mcp");
			});
	}, [agent, mcpController]);
	const submitManualMcp = useCallback(
		async (input: string, signal?: AbortSignal) => {
			const result = await mcpController.addManualServer(input, signal);
			noticeMcpAdded(result);
			if (!openMcpServer(result.name)) {
				setMode("mcp");
			}
		},
		[mcpController, noticeMcpAdded, openMcpServer],
	);
	const authenticateMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.authenticateServer(server, signal);
			const statuses = mcpController.listServerStatuses();
			const nextServer =
				statuses.find((candidate) => candidate.name === server.name) ?? server;
			setMcpServerStatuses(statuses);
			setSelectedMcpServer(nextServer);

			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			if (nextServer.status !== "connected") {
				const detail = nextServer.message
					? ` ${nextServer.message}`
					: warningNote;
				agent.notice(
					`Failed to authenticate MCP server: ${server.name}.${detail}`,
					"error",
				);
				return;
			}

			const toolsNote =
				result.toolNames.length > 0
					? ` Loaded ${result.toolNames.length} ${pluralize(result.toolNames.length, "tool")}.`
					: " No tools loaded.";
			agent.notice(
				`Authenticated MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
		},
		[agent, mcpController],
	);
	const disableMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.disableServer(server, signal);
			const toolsNote =
				result.toolNames.length > 0
					? ` Unloaded ${result.toolNames.length} ${pluralize(result.toolNames.length, "tool")}.`
					: "";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Disabled MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
			const statuses = mcpController.listServerStatuses();
			setMcpServerStatuses(statuses);
			setSelectedMcpServer(
				statuses.find((candidate) => candidate.name === server.name) ?? null,
			);
		},
		[agent, mcpController],
	);
	const removeMcpServer = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.removeServer(server, signal);
			const toolsNote =
				result.toolNames.length > 0
					? ` Unloaded ${result.toolNames.length} ${pluralize(result.toolNames.length, "tool")}.`
					: "";
			const warningNote =
				result.warnings.length > 0 ? ` ${result.warnings.join(" ")}` : "";
			agent.notice(
				`Removed MCP server: ${server.name}.${toolsNote}${warningNote}`,
			);
			setSelectedMcpServer(null);
			refreshMcpStatuses();
			setMode("mcp");
		},
		[agent, mcpController, refreshMcpStatuses],
	);
	const browseMcpPrimitives = useCallback(
		async (server: McpServerRuntimeStatus, signal: AbortSignal) => {
			const result = await mcpController.browsePrimitives(server, signal);
			if (result.warnings.length > 0) {
				agent.notice(result.warnings.join(" "), "error");
			}
			setMcpPrompts(result.prompts);
			setMcpResources(result.resources);
			setMcpResourceTemplates(result.templates);
			const statuses = refreshMcpStatuses();
			setSelectedMcpServer(
				statuses.find((candidate) => candidate.name === server.name) ?? server,
			);
			setMode("mcp-primitives");
		},
		[agent, mcpController, refreshMcpStatuses],
	);
	const selectMcpPrimitive = useCallback(
		async (selection: McpPrimitiveSelection, signal: AbortSignal) => {
			if (!selectedMcpServer) return;
			if (selection.type === "prompt") {
				if ((selection.prompt.arguments ?? []).length > 0) {
					setPendingMcpArguments(selection);
					setMode("mcp-arguments");
					return;
				}
				const result = await mcpController.getPrompt(
					selectedMcpServer,
					selection.prompt.name,
					undefined,
					signal,
				);
				submitPrompt(formatMcpPromptForUser(selectedMcpServer.name, result));
				setMode("normal");
				return;
			}
			if (selection.type === "resource") {
				if (selection.action === "subscribe") {
					await mcpController.subscribeResource(
						selectedMcpServer,
						selection.resource.uri,
						signal,
					);
					agent.notice(`Subscribed MCP resource: ${selection.resource.uri}`);
					const statuses = refreshMcpStatuses();
					setSelectedMcpServer(
						statuses.find(
							(candidate) => candidate.name === selectedMcpServer.name,
						) ?? selectedMcpServer,
					);
					setMode("mcp-primitives");
					return;
				}
				if (selection.action === "unsubscribe") {
					await mcpController.unsubscribeResource(
						selectedMcpServer,
						selection.resource.uri,
						signal,
					);
					agent.notice(`Unsubscribed MCP resource: ${selection.resource.uri}`);
					const statuses = refreshMcpStatuses();
					setSelectedMcpServer(
						statuses.find(
							(candidate) => candidate.name === selectedMcpServer.name,
						) ?? selectedMcpServer,
					);
					setMode("mcp-primitives");
					return;
				}
				const result = await mcpController.readResource(
					selectedMcpServer,
					selection.resource.uri,
					signal,
				);
				submitPrompt(
					formatMcpResourceForUser(selectedMcpServer.name, result.contents),
				);
				setMode("normal");
				return;
			}
			const fields = resourceTemplateFields(selection.template.uriTemplate);
			if (fields.length > 0) {
				setPendingMcpArguments(selection);
				setMode("mcp-arguments");
				return;
			}
			const result = await mcpController.readResource(
				selectedMcpServer,
				selection.template.uriTemplate,
				signal,
			);
			submitPrompt(
				formatMcpResourceForUser(selectedMcpServer.name, result.contents),
			);
			setMode("normal");
		},
		[agent, mcpController, refreshMcpStatuses, selectedMcpServer, submitPrompt],
	);
	const submitMcpArguments = useCallback(
		async (values: Record<string, string>, signal: AbortSignal) => {
			if (!selectedMcpServer || !pendingMcpArguments) return;
			if (pendingMcpArguments.type === "prompt") {
				const result = await mcpController.getPrompt(
					selectedMcpServer,
					pendingMcpArguments.prompt.name,
					values,
					signal,
				);
				submitPrompt(formatMcpPromptForUser(selectedMcpServer.name, result));
				setPendingMcpArguments(null);
				setMode("normal");
				return;
			}
			const result = await mcpController.readResourceTemplate(
				selectedMcpServer,
				pendingMcpArguments.template.uriTemplate,
				values,
				signal,
			);
			submitPrompt(
				formatMcpResourceForUser(selectedMcpServer.name, result.contents),
			);
			setPendingMcpArguments(null);
			setMode("normal");
		},
		[mcpController, pendingMcpArguments, selectedMcpServer, submitPrompt],
	);
	const selectMcpAction = useCallback(
		(selection: McpManagerSelection) => {
			if (selection.type === "server") {
				setSelectedMcpServer(selection.server);
				setMode("mcp-server");
				return;
			}
			if (selection.type === "registry") {
				openMcpRegistry();
				return;
			}
			setMode("mcp-manual");
		},
		[openMcpRegistry],
	);
	const applyExpertSelection = useCallback(
		async (selectedModel: ModelInfo, choice: ThinkingChoice) => {
			if (controller.hasActiveWork) {
				agent.notice(
					"Finish or cancel the current turn before changing expert mode.",
					"error",
				);
				setPendingModel(null);
				setMode("settings");
				return;
			}
			config.setExpertMode({
				enabled: true,
				model: {
					provider: selectedModel.provider,
					model: selectedModel.model,
				},
				thinking: choice.value,
			});
			try {
				await config.saveExpertPreference();
				agent.notice(
					`Expert mode on — ${formatModel(config.model)} plans, ${formatModel(
						selectedModel,
					)} implements · thinking ${choice.label}`,
				);
			} catch (err) {
				agent.notice(
					`Expert mode is on for this session, but saving the selection failed: ${errorMessage(
						err,
					)}`,
					"error",
				);
			} finally {
				setPendingModel(null);
				setMode("settings");
			}
		},
		[agent, config, controller],
	);
	const applyModelSelection = useCallback(
		async (selectedModel: ModelInfo, choice: ThinkingChoice) => {
			if (modelPickerTarget === "expert") {
				await applyExpertSelection(selectedModel, choice);
				return;
			}
			controller.setModelContextLimit(selectedModel.contextLimit ?? null);
			config.setModel({
				provider: selectedModel.provider,
				model: selectedModel.model,
			});
			config.setThinking(choice.value);
			agent.setModelLabel(formatModel(selectedModel));
			try {
				await config.saveRuntimeSelection();
				agent.notice(
					`Model: ${formatModel(selectedModel)} · thinking ${choice.label}`,
				);
			} catch (err) {
				agent.notice(
					`Model changed for this session, but saving the selection failed: ${errorMessage(
						err,
					)}`,
					"error",
				);
			} finally {
				setPendingModel(null);
				setMode("normal");
			}
		},
		[agent, applyExpertSelection, config, controller, modelPickerTarget],
	);
	const applyModel = useCallback(
		async (choice: ThinkingChoice) => {
			if (!pendingModel) return;
			await applyModelSelection(pendingModel, choice);
		},
		[applyModelSelection, pendingModel],
	);
	const closeMemorySelector = useCallback(() => {
		if (memoryReturnsToSettings) {
			setMemoryReturnsToSettings(false);
			setMode("settings");
		} else {
			setMode("normal");
		}
	}, [memoryReturnsToSettings]);
	const applyMemory = useCallback(
		async (choice: MemoryChoice) => {
			config.setMemory(choice.mode);
			try {
				await config.saveRuntimeSelection();
				agent.notice(`Memory: ${choice.label}`);
			} catch (err) {
				agent.notice(
					`Memory changed for this session, but saving the selection failed: ${errorMessage(
						err,
					)}`,
					"error",
				);
			} finally {
				closeMemorySelector();
			}
		},
		[agent, config, closeMemorySelector],
	);
	const applyResumeTarget = useCallback(
		async (load: () => Promise<ResumeTarget>) => {
			if (controller.hasActiveWork) {
				agent.notice(
					"Finish or cancel the current turn before switching sessions.",
					"error",
				);
				setMode("normal");
				return;
			}
			try {
				const target = await load();
				if (controller.hasActiveWork) {
					throw new Error(
						"A turn started while the session was loading. Cancel it before resuming.",
					);
				}
				await controller.beginSessionReplacement();
				await activateResumeTarget(target, {
					config,
					controller,
					onResumeLocalSession,
					onResumeRemoteSession,
				});
				if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
				agent.setModelLabel(config.modelString);
				agent.hydrateTranscript(target.messages);
				const visibleMessages = target.messages.filter(
					(message) =>
						message.role !== "assistant" || message.text.trim().length > 0,
				).length;
				agent.notice(
					`Resumed session: ${target.displayTitle} · ${visibleMessages} ${pluralize(visibleMessages, "message")}`,
				);
				setShowBanner(false);
				setMode("normal");
			} catch (error) {
				agent.notice(
					`Failed to resume session: ${errorMessage(error)}`,
					"error",
				);
				setMode("normal");
			}
		},
		[
			agent,
			config,
			controller,
			onResumeLocalSession,
			onResumeRemoteSession,
			stdout,
			write,
		],
	);
	const resumeSession = useCallback(
		(thread: BackboardThread) =>
			applyResumeTarget(() => hydrateResumeTarget(client, thread)),
		[applyResumeTarget, client],
	);
	const resumeSessionById = useCallback(
		(id: string) => {
			if (
				isAlreadyActiveResume(id, controller.threadId, getActiveSessionId())
			) {
				agent.notice("That session is already active.");
				setMode("normal");
				return Promise.resolve();
			}
			return applyResumeTarget(async () =>
				resolveResumeTarget(
					client,
					config.cwd,
					id,
					await lookupResumeEntry(id),
				),
			);
		},
		[
			agent,
			applyResumeTarget,
			client,
			config.cwd,
			controller.threadId,
			getActiveSessionId,
		],
	);

	const performRestore = useCallback(
		async (
			restore: PendingRestore,
			opts: { skipDiverged: boolean; onlyIncluded?: boolean },
		) => {
			if (!checkpoints) return;
			setLoadingLabel("Restoring files");
			setMode("loading");
			try {
				const plan = opts.onlyIncluded
					? {
							...restore.plan,
							entries: restore.plan.entries.filter((entry) =>
								restore.included.has(entry.path),
							),
						}
					: restore.plan;
				const result = await checkpoints.restore(plan, {
					skipDiverged: opts.skipDiverged,
				});
				agent.notice(
					restoreNotice(restore.verb, restore.summary, result),
					result.skipped.length > 0 ? "warning" : "info",
				);
				// The conversation is not rewound, so tell the model on its next
				// turn that disk state moved out from under its earlier tool results.
				pendingModelNotes.current.push(
					restoreModelNote(restore.verb, restore.summary, result),
				);
			} catch (err) {
				agent.notice(`Failed to restore files: ${errorMessage(err)}`, "error");
			} finally {
				setPendingRestore(null);
				setMode("normal");
			}
		},
		[agent, checkpoints],
	);
	const startRestore = useCallback(
		async (checkpointId: string, verb: RestoreVerb) => {
			if (!checkpoints) return;
			try {
				const plan = await checkpoints.planRestore(checkpointId);
				const summary =
					checkpoints
						.listCheckpoints()
						.find((checkpoint) => checkpoint.id === checkpointId) ?? null;
				const revertible = plan.entries.filter(
					(entry) => entry.action === "write" || entry.action === "delete",
				);
				const pending: PendingRestore = {
					plan,
					summary,
					verb,
					included: new Set(revertible.map((entry) => entry.path)),
				};
				// /rewind always pauses on the options screen; /undo and /redo stay
				// one-keystroke fast unless hand edits would be overwritten.
				if (verb === "rewind" || revertible.some((entry) => entry.diverged)) {
					setPendingRestore(pending);
					setMode("rewind-confirm");
					return;
				}
				void performRestore(pending, { skipDiverged: false });
			} catch (err) {
				agent.notice(
					`Failed to plan the restore: ${errorMessage(err)}`,
					"error",
				);
				setMode("normal");
			}
		},
		[agent, checkpoints, performRestore],
	);

	const quit = useCallback(() => {
		onExit();
		app.exit();
	}, [app, onExit]);
	const logout = useCallback(() => {
		void onLogout()
			.then(() => {
				agent.cancel();
				onExit();
				app.exit();
			})
			.catch((err) => {
				agent.notice(`Failed to sign out: ${errorMessage(err)}`, "error");
			});
	}, [agent, app, onExit, onLogout]);
	const login = useCallback(() => {
		setLoadingLabel("Waiting for Backboard login");
		setMode("loading");
		void onLogin((response) => {
			agent.notice(
				[
					"Open this URL on any device with a browser (code already filled in):",
					response.verification_uri_complete,
					"",
					`Or go to ${response.verification_uri} and enter code: ${response.user_code}`,
				].join("\n"),
			);
		})
			.then((message) => {
				refreshCredentials();
				agent.notice(message);
				setSessionEnded(false);
				setMode("normal");
			})
			.catch((err) => {
				agent.notice(`Failed to sign in: ${errorMessage(err)}`, "error");
				setMode("normal");
			});
	}, [agent, onLogin, refreshCredentials]);
	const toggleBrowser = useCallback(
		(opts?: { silent?: boolean }) => {
			const enabled = !controller.isBrowserUseEnabled;
			controller.setBrowserUseEnabled(enabled);
			if (opts?.silent) return;
			agent.notice(
				enabled
					? "Browser use enabled for this session."
					: "Browser use disabled for this session.",
				enabled ? "info" : "warning",
			);
		},
		[agent, controller],
	);
	const toggleComputerUse = useCallback(
		(opts?: { silent?: boolean }) => {
			const enabled = !controller.isComputerUseEnabled;
			controller.setComputerUseEnabled(enabled);
			if (opts?.silent) return;
			agent.notice(
				enabled
					? `Computer use enabled for this session. ${computerUseHint()}`
					: "Computer use disabled for this session.",
				enabled ? "info" : "warning",
			);
		},
		[agent, controller],
	);
	const toggleDiscovery = useCallback(
		(opts?: { silent?: boolean }) => {
			const enabled = !controller.isSkillDiscoveryEnabled;
			controller.setSkillDiscoveryEnabled(enabled);
			if (opts?.silent) return;
			agent.notice(
				`Skill discovery ${enabled ? "enabled" : "disabled"} for this session.`,
				enabled ? "info" : "warning",
			);
		},
		[agent, controller],
	);
	const openSettings = useCallback(() => {
		verboseAtSettingsOpen.current = config.isVerbose;
		setMode("settings");
	}, [config]);
	const closeSettings = useCallback(() => {
		setMode("normal");
	}, []);
	const previousMode = useRef(mode);
	useEffect(() => {
		const previous = previousMode.current;
		previousMode.current = mode;
		if (
			!shouldReprintOnSettingsExit({
				previousMode: previous,
				mode,
				memoryReturnsToSettings,
				verboseAtOpen: verboseAtSettingsOpen.current,
				verboseNow: config.isVerbose,
			})
		) {
			return;
		}
		if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
		setVerboseEpoch((epoch) => epoch + 1);
	}, [mode, memoryReturnsToSettings, config, stdout, write]);
	const openMemoryFromSettings = useCallback(() => {
		setMemoryReturnsToSettings(true);
		setMode("memory");
	}, []);
	// Enter on the Expert row turns it off when on, and opens the model picker
	// when off. The pick is remembered, so an off/on cycle re-picks by choice.
	const toggleExpertMode = useCallback(() => {
		if (controller.hasActiveWork) {
			agent.notice(
				"Finish or cancel the current turn before changing expert mode.",
				"error",
			);
			return;
		}
		if (!config.isExpertModeEnabled) {
			openModelPicker("expert");
			return;
		}
		config.setExpertMode({ enabled: false });
		agent.notice(
			`Expert mode off — ${formatModel(config.model)} implements again.`,
		);
		void config.saveExpertPreference().catch((err) => {
			agent.notice(
				`Failed to save expert preference: ${errorMessage(err)}`,
				"error",
			);
		});
		forceSettingsRender();
	}, [agent, config, controller, openModelPicker]);
	const openSettingsRow = useCallback(
		(id: SettingsOpenId) => {
			if (id === "memory") {
				openMemoryFromSettings();
				return;
			}
			toggleExpertMode();
		},
		[openMemoryFromSettings, toggleExpertMode],
	);
	const persistVerbose = useCallback(
		(next: boolean) => {
			config.setVerbose(next);
			setVerbose(next);
			void config.saveVerbosePreference().catch((err) => {
				agent.notice(
					`Failed to save verbose preference: ${errorMessage(err)}`,
					"error",
				);
			});
		},
		[agent, config],
	);
	const persistNotify = useCallback(
		(next: boolean) => {
			config.setNotifyEnabled(next);
			void config.saveNotifyPreference().catch((err) => {
				agent.notice(
					`Failed to save notify preference: ${errorMessage(err)}`,
					"error",
				);
			});
		},
		[agent, config],
	);
	const toggleSetting = useCallback(
		(id: SettingsToggleId) => {
			switch (id) {
				case "verbose":
					persistVerbose(!config.isVerbose);
					break;
				case "notify":
					persistNotify(!config.isNotifyEnabled);
					break;
				case "lsp":
					toggleLsp({ silent: true });
					break;
				case "browser":
					toggleBrowser({ silent: true });
					break;
				case "computerUse":
					toggleComputerUse({ silent: true });
					break;
				case "discover":
					toggleDiscovery({ silent: true });
					break;
			}
			forceSettingsRender();
		},
		[
			config,
			persistNotify,
			persistVerbose,
			toggleBrowser,
			toggleComputerUse,
			toggleDiscovery,
			toggleLsp,
		],
	);
	const modelPickerReturnMode: Mode =
		modelPickerTarget === "expert" ? "settings" : "normal";
	const settingsState: SettingsState | null =
		mode === "settings"
			? {
					memory: config.memory,
					expert: {
						enabled: config.isExpertModeEnabled,
						model: config.expertModel ? formatModel(config.expertModel) : null,
					},
					verbose: config.isVerbose,
					notify: config.isNotifyEnabled,
					lsp: lsp.enabled,
					lspPending,
					browser: controller.isBrowserUseEnabled,
					computerUse: controller.isComputerUseEnabled,
					discover: controller.isSkillDiscoveryEnabled,
				}
			: null;
	const running = agent.state.status === "running";
	const allowPromptCommand = useCallback(
		(command: Parameters<typeof canRunCommandAfterSessionEnd>[0]) =>
			!sessionEnded || canRunCommandAfterSessionEnd(command),
		[sessionEnded],
	);
	const cancelUserTurns = useCallback(() => {
		setQueuedPrompts([]);
		agent.cancel();
	}, [agent]);
	const cancelActiveUserTurn = useCallback(() => {
		agent.cancelCurrent();
	}, [agent]);

	useInput((_input, key) => {
		if (key.tab && key.shift) {
			agent.cycleMode();
			return;
		}
		if (key.escape && agent.state.status === "running") {
			cancelActiveUserTurn();
			return;
		}
		if (!key.ctrl || _input !== "c") return;
		if (agent.state.status === "running") {
			cancelUserTurns();
			return;
		}
		const now = Date.now();
		if (now - lastCtrlC < DOUBLE_CTRL_C_MS) {
			quit();
		} else {
			setLastCtrlC(now);
			agent.notice("Press Ctrl+C again to exit.");
		}
	});

	const handleSubmit = useCallback(
		(
			raw: string,
			intent: "send" | "steer" | "queue",
			attachmentIds?: string[],
		) => {
			const command = parseCommand(raw);
			if (
				controller.hasActiveWork &&
				(command.type === "new" || command.type === "sessions")
			) {
				agent.notice(
					"Finish or cancel the current turn before switching sessions.",
					"error",
				);
				return;
			}
			if (command.type !== "message" && attachmentIds?.length) {
				// Slash commands can't carry attachments: drop the staged docs.
				cleanupClipboardImages(
					attachmentIds
						.flatMap((id) => attachments.remove(id) ?? [])
						.map((item) => item.filePath),
				);
				attachmentIds = undefined;
			}
			if (running && command.type === "message") {
				const text = command.text;
				if (!text) return;
				if (intent === "queue") {
					nextQueuedPromptId.current += 1;
					const queuedPrompt = {
						id: `queue-${nextQueuedPromptId.current}`,
						text,
					};
					setQueuedPrompts((current) => [...current, queuedPrompt]);
					submitPrompt(text, {
						attachmentIds,
						onStart: () =>
							setQueuedPrompts((current) =>
								current.filter((prompt) => prompt.id !== queuedPrompt.id),
							),
					});
					return;
				}
				submitPrompt(text, {
					steer: true,
					attachmentIds,
					onStart: () =>
						agent.notice(`Steering with ${formatInlinePrompt(text)}`),
				});
				return;
			}
			if (sessionEnded && !canRunCommandAfterSessionEnd(command.type)) {
				agent.notice(
					`This ${APP_DISPLAY_NAME} session has ended. Run /login to sign in again or /exit to close ${APP_DISPLAY_NAME}.`,
					"error",
				);
				return;
			}
			switch (command.type) {
				case "message":
					submitPrompt(command.text, { attachmentIds });
					break;
				case "help":
					agent.notice(HELP_TEXT);
					break;
				case "new":
					cleanupClipboardImages(
						attachments.clearAll().map((item) => item.filePath),
					);
					setLoadingLabel("Starting session");
					setMode("loading");
					void startNewSession({
						detach: () => controller.beginSessionReplacement(),
						activate: onNewSession,
						resetThread: () => agent.newThread(),
					})
						.then(() => {
							if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
							setShowBanner(true);
							setMode("normal");
						})
						.catch((error) => {
							agent.notice(
								`Failed to start a new session: ${errorMessage(error)}`,
								"error",
							);
							setMode("normal");
						});
					break;
				case "quit":
					quit();
					break;
				case "login":
					login();
					break;
				case "logout":
					logout();
					break;
				case "model":
					openModelSelector();
					break;
				case "memory":
					setMemoryReturnsToSettings(false);
					setMode("memory");
					break;
				case "settings":
					openSettings();
					break;
				case "lsp":
					toggleLsp();
					break;
				case "providers":
					setMode("keys");
					break;
				case "context":
					openContextPanel();
					break;
				case "compress":
					// The compactor is the single place that decides whether there
					// is anything worth compressing; it reports why if there isn't.
					void runCompaction("manual");
					break;
				case "mcp":
					setLoadingLabel("Loading MCP servers");
					setMode("loading");
					void mcpController
						.refreshPromptAndResourceUpdates()
						.then((result) => {
							if (result.warnings.length > 0) {
								agent.notice(result.warnings.join(" "), "error");
							}
							if (result.updatedResourceUris.length > 0) {
								agent.notice(
									`Updated MCP resources: ${result.updatedResourceUris.join(", ")}`,
								);
							}
							refreshMcpStatuses();
							setMode("mcp");
						})
						.catch((err) => {
							agent.notice(errorMessage(err), "error");
							refreshMcpStatuses();
							setMode("mcp");
						});
					break;
				case "hooks":
					openHookManager();
					break;
				case "skills":
					openSkillsSelector();
					break;
				case "sessions":
					if (command.id) {
						setLoadingLabel("Resuming session");
						setMode("loading");
						void resumeSessionById(command.id);
					} else {
						openSessionsSelector();
					}
					break;
				case "notify": {
					const next = !config.isNotifyEnabled;
					persistNotify(next);
					agent.notice(
						`Completion notifications ${next ? "enabled" : "disabled"}.`,
					);
					break;
				}
				case "cua":
					toggleComputerUse();
					break;
				case "browser":
					toggleBrowser();
					break;
				case "discover":
					toggleDiscovery();
					break;
				case "verbose": {
					const next = !config.isVerbose;
					persistVerbose(next);
					// Bumping verboseEpoch remounts <Static>, which reprints every
					// transcript item. Clear the visible screen first (as the resize
					// path does) so the reprint replaces the old output instead of
					// appending a duplicate copy below it.
					if (stdout.isTTY) write(CLEAR_VISIBLE_SCREEN);
					setVerboseEpoch((epoch) => epoch + 1);
					agent.notice(
						`Detailed tool output ${next ? "enabled" : "disabled"}.`,
					);
					break;
				}
				case "update":
					agent.notice("Checking for updates…");
					void checkForCliUpdate({
						apiUrl: config.env.apiUrl,
						currentVersion: APP_VERSION,
					}).then((result) => {
						if (result.status === "update-available") {
							agent.notice(
								`Update available: ${result.currentVersion} → ${result.latestVersion}\nRun: ${result.command}`,
								"warning",
							);
						} else if (result.status === "up-to-date") {
							agent.notice(
								`You're on the latest version (${result.currentVersion}).`,
							);
						} else {
							agent.notice(
								`Could not check for updates: ${result.error}`,
								"error",
							);
						}
					});
					break;
				case "undo":
				case "redo":
				case "rewind": {
					if (running) {
						agent.notice(
							`Stop the agent first (Esc), then /${command.type}.`,
							"error",
						);
						break;
					}
					if (!checkpoints) {
						agent.notice(
							"File checkpoints are not available in this session.",
							"error",
						);
						break;
					}
					if (command.type === "rewind") {
						const list = checkpoints.listCheckpoints();
						if (list.length === 0) {
							agent.notice("No checkpoints in this session yet.");
							break;
						}
						setRewindCheckpoints(list);
						setMode("rewind");
						break;
					}
					const target =
						command.type === "undo"
							? checkpoints.undoTarget()
							: checkpoints.redoTarget();
					if (!target) {
						agent.notice(
							command.type === "undo" ? "Nothing to undo." : "Nothing to redo.",
						);
						break;
					}
					void startRestore(target, command.type);
					break;
				}
				case "unknown":
					agent.notice(
						skillController.isSkillLoaded(command.name)
							? `Unknown command: /${command.name}. Invoke the loaded skill with $${command.name} or from /skills.`
							: `Unknown command: /${command.name}`,
						"error",
					);
					break;
			}
		},
		[
			agent,
			checkpoints,
			config,
			controller,
			login,
			mcpController,
			attachments,
			logout,
			openHookManager,
			openModelSelector,
			openContextPanel,
			onNewSession,
			runCompaction,
			openSessionsSelector,
			openSettings,
			openSkillsSelector,
			persistNotify,
			persistVerbose,
			quit,
			refreshMcpStatuses,
			resumeSessionById,
			running,
			sessionEnded,
			skillController,
			startRestore,
			stdout,
			submitPrompt,
			toggleBrowser,
			toggleComputerUse,
			toggleDiscovery,
			toggleLsp,
			write,
		],
	);

	const resize = useResizeStabilizer(terminalSize, {
		isTerminal: stdout.isTTY,
		write,
	});
	const todoPanelDisplay = todoPanelDisplayForTerminalHeight(terminalSize.rows);
	const transcriptLayout = useStableTranscriptLayout(
		agent.state.render.staticItems,
		transcriptTailItemsForLayout({
			running,
			staticOnly: agent.state.render.staticOnly,
			hasTodos: agent.state.todos.length > 0,
			compactTodos: todoPanelDisplay.compact,
		}),
		agent.state.render.generation,
	);
	const staticGeneration =
		agent.state.render.generation + resize.resizeEpoch + verboseEpoch;
	const staticBanner = useStableStaticBanner(
		showBanner ? banner : null,
		staticGeneration,
	);
	const liveItems = compactLiveTranscriptItems(agent.state.render.liveItems);

	if (resize.isResizing) {
		return <Box />;
	}

	return (
		<TerminalSizeProvider size={terminalSize}>
			<VerboseProvider verbose={verbose}>
				<Box flexDirection="column">
					<StaticTranscript
						items={transcriptLayout.staticItems}
						generation={staticGeneration}
						banner={staticBanner}
					/>
					<MessageList
						items={[...transcriptLayout.responsiveItems, ...liveItems]}
					/>
					<TodoPanel todos={agent.state.todos} display={todoPanelDisplay} />

					{running && !agent.state.pendingAsk ? (
						<Box marginTop={1}>
							<Spinner showElapsed showInterruptHint showResultMarker />
						</Box>
					) : null}

					{agent.state.pendingAsk ? (
						<AskUserPrompt
							key={agent.state.pendingAsk.id}
							request={agent.state.pendingAsk}
							onComplete={agent.provideInput}
						/>
					) : mode === "loading" ? (
						<Box marginTop={1}>
							<Spinner label={loadingLabel} showResultMarker />
						</Box>
					) : mode === "model" ? (
						<ModelSelector
							models={models}
							onSelect={(model) => {
								if (modelUsesAutomaticThinkingOnly(model)) {
									void applyModelSelection(model, {
										label: "automatic",
										value: undefined,
									});
									return;
								}
								setPendingModel(model);
								setMode("thinking");
							}}
							onCancel={() => setMode(modelPickerReturnMode)}
						/>
					) : mode === "thinking" ? (
						pendingModel ? (
							<ThinkingSelector
								model={pendingModel}
								onSelect={applyModel}
								onCancel={() => {
									setPendingModel(null);
									setMode(modelPickerReturnMode);
								}}
							/>
						) : null
					) : mode === "memory" ? (
						<MemorySelector
							currentMode={config.memory}
							onSelect={applyMemory}
							onCancel={closeMemorySelector}
						/>
					) : mode === "settings" && settingsState ? (
						<SettingsPanel
							state={settingsState}
							onToggle={toggleSetting}
							onOpen={openSettingsRow}
							onClose={closeSettings}
						/>
					) : mode === "skills" ? (
						<SkillsSelector
							tabs={skillTabs}
							initialItem={selectedSkillItem}
							onSelect={(item) => {
								setSelectedSkillItem(item);
								setMode("skill-actions");
							}}
							onCancel={() => {
								setSelectedSkillItem(null);
								setMode("normal");
							}}
						/>
					) : mode === "skill-actions" && selectedSkillItem ? (
						<SkillActions
							item={selectedSkillItem}
							onLoad={loadSkillFromActions}
							onUnload={unloadSkillFromActions}
							onRemove={removeSkillFromActions}
							onCancel={() => setMode("skills")}
						/>
					) : mode === "sessions" ? (
						<SessionsSelector
							threads={sessionThreads}
							onSelect={resumeSession}
							onCancel={() => setMode("normal")}
						/>
					) : mode === "hooks" && hookSnapshot ? (
						<HookManagerSelector
							snapshot={hookSnapshot}
							onSelect={selectHookManagerItem}
							onCancel={() => setMode("normal")}
						/>
					) : mode === "hooks-event" && hookSnapshot && selectedHookEvent ? (
						<HookEventSelector
							event={selectedHookEvent}
							snapshot={hookSnapshot}
							onSelect={selectHookEventItem}
							onAddHook={startAddHook}
							onCancel={() => setMode("hooks")}
						/>
					) : mode === "hooks-matcher" &&
						selectedHookEvent &&
						pendingHookMatcher ? (
						<HookMatcherSelector
							event={selectedHookEvent.event}
							matcher={pendingHookMatcher}
							hooks={selectedHookMatcherHooks}
							onSelect={viewHookDetails}
							onAddHook={startAddHook}
							onDelete={removeHook}
							onCancel={() => setMode("hooks-event")}
						/>
					) : mode === "hook-detail" && selectedHook ? (
						<HookDetails
							hook={selectedHook}
							onDelete={removeHook}
							onCancel={() => setMode("hooks-matcher")}
						/>
					) : mode === "hooks-add" && addContext ? (
						<HookAddForm
							event={addContext.event}
							initialMatcher={addContext.initialMatcher}
							toolNames={addToolNames}
							onSubmit={addHook}
							onCancel={() =>
								setMode(selectedHookEvent ? "hooks-event" : "hooks")
							}
						/>
					) : mode === "context" && contextReport ? (
						<ContextPanel
							report={contextReport}
							onClose={() => {
								setContextReport(null);
								setMode("normal");
							}}
						/>
					) : mode === "keys" ? (
						<ProviderKeyManager
							controller={providerKeys}
							signedIn={config.hasBackboardAuth}
							onClose={(message) => {
								if (message) agent.notice(message, "info");
								setMode("normal");
							}}
						/>
					) : mode === "mcp" ? (
						<McpManagerSelector
							servers={mcpServerStatuses}
							onSelect={selectMcpAction}
							onCancel={() => setMode("normal")}
						/>
					) : mode === "mcp-server" && selectedMcpServer ? (
						<McpServerActions
							server={selectedMcpServer}
							onAuthenticate={authenticateMcpServer}
							onDisable={disableMcpServer}
							onRemove={removeMcpServer}
							onBrowse={browseMcpPrimitives}
							onCancel={() => {
								refreshMcpStatuses();
								setMode("mcp");
							}}
						/>
					) : mode === "mcp-primitives" && selectedMcpServer ? (
						<McpPrimitiveSelector
							serverName={selectedMcpServer.name}
							prompts={mcpPrompts}
							resources={mcpResources}
							templates={mcpResourceTemplates}
							resourceSubscriptions={Boolean(
								selectedMcpServer.capabilities?.resources?.subscribe,
							)}
							subscribedResourceUris={
								selectedMcpServer.subscribedResourceUris ?? []
							}
							updatedResourceUris={selectedMcpServer.updatedResourceUris ?? []}
							onSelect={selectMcpPrimitive}
							onCancel={() => setMode("mcp-server")}
						/>
					) : mode === "mcp-arguments" && pendingMcpArguments ? (
						<McpArgumentInput
							title={mcpArgumentTitle(pendingMcpArguments)}
							fields={mcpArgumentFields(pendingMcpArguments)}
							onSubmit={submitMcpArguments}
							onCancel={() => {
								setPendingMcpArguments(null);
								setMode("mcp-primitives");
							}}
						/>
					) : mode === "mcp-registry" ? (
						<McpRegistrySelector
							servers={mcpServers}
							onSelect={addMcpServer}
							onCancel={() => setMode("mcp")}
						/>
					) : mode === "mcp-manual" ? (
						<ManualMcpInput
							onSubmit={submitManualMcp}
							onCancel={() => setMode("mcp")}
						/>
					) : mode === "rewind" ? (
						<RewindSelector
							checkpoints={rewindCheckpoints}
							onSelect={(checkpoint) =>
								void startRestore(checkpoint.id, "rewind")
							}
							onCancel={() => setMode("normal")}
						/>
					) : mode === "rewind-confirm" && pendingRestore ? (
						<RestoreOptions
							plan={pendingRestore.plan}
							summary={pendingRestore.summary}
							onChoice={(choice: RestoreChoice) => {
								if (choice === "cancel") {
									setPendingRestore(null);
									setMode("normal");
									return;
								}
								if (choice === "choose-files") {
									setMode("rewind-files");
									return;
								}
								void performRestore(pendingRestore, {
									skipDiverged: choice === "skip-diverged",
								});
							}}
							onCancel={() => {
								setPendingRestore(null);
								setMode("normal");
							}}
						/>
					) : mode === "rewind-files" && pendingRestore ? (
						<FileSelect
							plan={pendingRestore.plan}
							included={pendingRestore.included}
							onToggle={(path) => {
								setPendingRestore((current) => {
									if (!current) return current;
									const included = new Set(current.included);
									if (included.has(path)) included.delete(path);
									else included.add(path);
									return { ...current, included };
								});
							}}
							onConfirm={() => {
								void performRestore(pendingRestore, {
									skipDiverged: false,
									onlyIncluded: true,
								});
							}}
							onCancel={() => setMode("rewind-confirm")}
						/>
					) : (
						<>
							<PromptInput
								busy={running}
								queuedPrompts={queuedPrompts}
								allowCommand={allowPromptCommand}
								promptHistory={promptHistory}
								onPromptHistoryChange={setPromptHistory}
								onSubmit={handleSubmit}
								onAttachFiles={(files) => attachments.add(files)}
								onRemoveAttachment={(id) => {
									const removed = attachments.remove(id);
									if (removed) cleanupClipboardImages([removed.filePath]);
								}}
								onNotice={(text, level) => agent.notice(text, level)}
							/>
							<StatusBar
								model={agent.state.model}
								thinking={config.thinking}
								permissionMode={agent.state.permissionMode}
								backgroundAgents={agent.state.backgroundAgents}
							/>
						</>
					)}

					{mode === "model" || mode === "thinking" || mode === "memory" ? (
						<Text color={theme.subtle}>
							Use ↑/↓ and Enter to select, Esc to cancel.
						</Text>
					) : null}
				</Box>
			</VerboseProvider>
		</TerminalSizeProvider>
	);
}

function restoreVerbPhrase(
	verb: RestoreVerb,
	summary: CheckpointSummary | null,
): string {
	if (verb === "redo") return "Redid the last undo";
	const label = summary ? ` ${quotedCheckpointLabel(summary.label)}` : "";
	return verb === "undo" ? `Undid${label}` : `Rewound to before${label}`;
}

function quotedCheckpointLabel(label: string): string {
	return `"${label.trim() || "(no message)"}"`;
}

function restoreFileCount(count: number): string {
	return `${count} ${pluralize(count, "file")}`;
}

function restoreSkipReason(reason: string): string {
	if (reason === "too_large") return "too large";
	if (reason === "diverged") return "hand-edited, skipped";
	return reason;
}

/** User-facing summary of a completed /undo, /redo, or /rewind restore. */
function restoreNotice(
	verb: RestoreVerb,
	summary: CheckpointSummary | null,
	result: RestoreResult,
): string {
	const changes: string[] = [];
	if (result.restored.length > 0) {
		changes.push(`restored ${restoreFileCount(result.restored.length)}`);
	}
	if (result.deleted.length > 0) {
		changes.push(`deleted ${restoreFileCount(result.deleted.length)}`);
	}
	if (changes.length === 0) changes.push("no files changed");
	const parts = [`${restoreVerbPhrase(verb, summary)} · ${changes.join(", ")}`];
	if (verb !== "redo" && result.redoCheckpointId) {
		parts.push("/redo to reapply");
	}
	const lines = [parts.join(" · ")];
	if (result.skipped.length > 0) {
		lines.push(
			`Skipped: ${result.skipped
				.map((skip) => `${skip.path} (${restoreSkipReason(skip.reason)})`)
				.join(", ")}`,
		);
	}
	return lines.join("\n");
}

/**
 * Provider-visible note prepended to the next prompt so the model learns the
 * disk moved out from under its earlier tool results.
 */
function restoreModelNote(
	verb: RestoreVerb,
	summary: CheckpointSummary | null,
	result: RestoreResult,
): string {
	const lines = [
		verb === "redo"
			? "The user ran /redo in the CLI: the file changes reverted by the previous /undo were just reapplied on disk."
			: `The user ran /${verb} in the CLI: file contents on disk were just reverted to their state before the turn ${
					summary ? quotedCheckpointLabel(summary.label) : "(unknown)"
				}.`,
	];
	if (result.restored.length > 0) {
		lines.push(`Restored: ${result.restored.join(", ")}`);
	}
	if (result.deleted.length > 0) {
		lines.push(`Deleted (had been created): ${result.deleted.join(", ")}`);
	}
	if (result.skipped.length > 0) {
		lines.push(
			`Not reverted: ${result.skipped
				.map((skip) => `${skip.path} (${restoreSkipReason(skip.reason)})`)
				.join(", ")}`,
		);
	}
	lines.push(
		"The conversation history was NOT rewound, so file contents shown in earlier tool results may be stale. Re-read these files before relying on or editing them. Non-file side effects of shell commands (network calls, databases, installed packages) were not reverted.",
	);
	return `<system-reminder>\n${lines.join("\n")}\n</system-reminder>`;
}

function mcpArgumentTitle(selection: PendingMcpArgumentSelection): string {
	if (selection.type === "prompt") {
		return `MCP prompt: ${selection.prompt.name}`;
	}
	return `MCP resource template: ${selection.template.name}`;
}

function mcpArgumentFields(
	selection: PendingMcpArgumentSelection,
): McpArgumentField[] {
	if (selection.type === "prompt") {
		return (selection.prompt.arguments ?? []).map((argument) => ({
			name: argument.name,
			description: argument.description,
			required: Boolean(argument.required),
		}));
	}
	return resourceTemplateFields(selection.template.uriTemplate);
}

function resourceTemplateFields(uriTemplate: string): McpArgumentField[] {
	return resourceTemplateVariables(uriTemplate).map((variable) => ({
		name: variable.name,
		required: variable.required,
	}));
}

function formatInlinePrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	return normalized.length > 100
		? `${normalized.slice(0, 97).trimEnd()}...`
		: normalized;
}

/** One-line setup reminder shown when computer use is switched on. */
function computerUseHint(): string {
	switch (process.platform) {
		case "darwin":
			return "The terminal needs Screen Recording and Accessibility permission; the first action compiles a small native helper (Xcode Command Line Tools).";
		case "win32":
			return "Actions run through a persistent PowerShell helper.";
		default:
			return "Local control is only supported on macOS and Windows.";
	}
}
