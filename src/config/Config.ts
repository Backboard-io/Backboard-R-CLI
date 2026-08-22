import { canonicalToolName } from "../core/tools/names.ts";
import { ToolPolicy } from "../core/tools/ToolPolicy.ts";
import {
	type AuthState,
	hasAnyCredentials,
	NO_CREDENTIALS_MESSAGE,
	resolveAuth,
} from "./auth.ts";
import type { ExpertConfig } from "./BackboardConfigTypes.ts";
import { readBackboardConfig, saveBackboardConfig } from "./backboardConfig.ts";
import {
	DEFAULTS,
	formatModel,
	keyOnlyDefaultModel,
	type MemoryMode,
	type MemoryProfile,
	type ModelRef,
	type OutputFormat,
	parseExcludedTools,
	parseMemoryMode,
	parseMemoryProfile,
	parseModel,
	parseOutputFormat,
	parseThinking,
	type ThinkingIntent,
} from "./defaults.ts";
import { type BackboardEnv, resolveApiUrl } from "./env.ts";
import { type CliFlags, parseFlags } from "./flags.ts";
import {
	type ModelProfile,
	resolveModelProfile,
} from "./modelProfiles/index.ts";
import {
	type HookConfigPaths,
	type McpConfigPaths,
	qProjectHookConfigPath,
	qProjectMcpConfigPath,
	qProjectWorkspaceId,
	qUserHookConfigPath,
	qUserMcpConfigPath,
} from "./paths.ts";
import { getProfile, type Profile } from "./profiles/index.ts";

export interface ConfigOptions {
	env?: BackboardEnv;
	argv?: string[];
	homeDir?: string;
}

/** Placeholder env used when the run authenticates with provider keys only. */
function anonymousEnv(): BackboardEnv {
	return { apiKey: "", apiUrl: resolveApiUrl() };
}

/**
 * Central runtime configuration. Merges, in priority order:
 *   defaults  <  active profile  <  CLI flags.
 * Holds the live model selection, which `/model` mutates at runtime.
 */
export class Config {
	readonly env: BackboardEnv;
	/** Credentials this run may use: a Backboard sign-in, provider keys, or both. */
	auth: AuthState;
	readonly flags: CliFlags;
	readonly cwd: string;
	readonly profile: Profile;
	readonly mcpConfigPaths: McpConfigPaths;
	readonly hookConfigPaths: HookConfigPaths;
	private readonly homeDir: string | undefined;
	private workspaceId: string | null = null;

	private currentModel: ModelRef;
	private currentModelProfile: ModelProfile;
	private readonly currentFormat: OutputFormat;
	private currentMemory: MemoryMode;
	private computerUseEnabled = false;
	private browserUseEnabled = false;
	private skillDiscoveryEnabled = false;
	private notifyEnabled = false;
	private verboseEnabled = true;
	private readonly currentMemoryProfile: MemoryProfile;
	private currentThinking: ThinkingIntent | null | undefined;
	private expertEnabled = false;
	private expertModelRef: ModelRef | null = null;
	private expertModelProfile: ModelProfile | null = null;
	private expertThinking: ThinkingIntent | null | undefined;
	private readonly currentFinalVerificationNudge: boolean;
	private readonly excludedToolNames: string[];
	private readonly persistedConfigHomeDir: string | undefined;

	constructor(options: ConfigOptions = {}) {
		this.flags = parseFlags(options.argv ?? process.argv.slice(2));
		this.homeDir = options.homeDir;
		this.auth = resolveAuth(
			options.homeDir === undefined ? {} : { homeDir: options.homeDir },
		);
		if (options.env) {
			// An injected env is an explicit Backboard credential (tests, evals).
			this.auth = { ...this.auth, backboard: options.env };
		} else if (!hasAnyCredentials(this.auth)) {
			throw new Error(NO_CREDENTIALS_MESSAGE);
		}
		this.env = this.auth.backboard ?? anonymousEnv();
		this.persistedConfigHomeDir = options.homeDir;
		const persistedConfig =
			options.homeDir !== undefined || options.env === undefined
				? readBackboardConfig(options.homeDir)
				: {};

		const profileName = this.flags.profile ?? DEFAULTS.profile;
		this.profile = getProfile(profileName);

		this.cwd = this.flags.cwd ?? process.cwd();
		this.mcpConfigPaths = {
			project: qProjectMcpConfigPath(this.cwd),
			user: qUserMcpConfigPath(),
		};
		this.hookConfigPaths = {
			project: qProjectHookConfigPath(this.cwd),
			user: qUserHookConfigPath(options.homeDir),
		};
		const keyOnlyDefault =
			this.auth.backboard === null && persistedConfig.model === undefined
				? keyOnlyDefaultModel(this.auth.providerKeys[0]?.provider)
				: null;
		this.currentModel = this.flags.model
			? parseModel(this.flags.model)
			: (persistedConfig.model ?? keyOnlyDefault ?? this.profile.model);
		this.currentModelProfile = resolveModelProfile(this.currentModel);
		this.currentFormat = this.flags.format
			? parseOutputFormat(this.flags.format)
			: "default";
		this.currentMemory = this.flags.memory
			? parseMemoryMode(this.flags.memory)
			: (persistedConfig.memory ?? this.profile.memory);
		this.currentMemoryProfile = this.flags.memoryProfile
			? parseMemoryProfile(this.flags.memoryProfile)
			: (persistedConfig.memoryProfile ?? this.profile.memoryProfile);
		this.currentThinking =
			this.flags.thinking === undefined
				? persistedConfig.thinking
				: parseThinking(this.flags.thinking);
		this.currentFinalVerificationNudge =
			this.flags.finalVerification ?? DEFAULTS.finalVerificationNudge;
		const expert = persistedConfig.expert;
		this.expertEnabled = expert?.enabled ?? false;
		this.expertModelRef = expert?.model ?? null;
		this.expertModelProfile = expert?.model
			? resolveModelProfile(expert.model)
			: null;
		this.expertThinking = expert?.thinking;
		this.notifyEnabled = persistedConfig.notify ?? false;
		this.verboseEnabled = persistedConfig.verbose ?? true;
		this.excludedToolNames = parseExcludedTools(this.flags.excludedTools).map(
			canonicalToolName,
		);
	}

	get model(): ModelRef {
		return this.currentModel;
	}

	get modelString(): string {
		return formatModel(this.currentModel);
	}

	setModel(ref: ModelRef): void {
		this.currentModel = ref;
		this.currentModelProfile = resolveModelProfile(ref);
	}

	get modelProfile(): ModelProfile {
		return this.currentModelProfile;
	}

	get format(): OutputFormat {
		return this.currentFormat;
	}

	get memory(): MemoryMode {
		return this.currentMemory;
	}

	setMemory(mode: MemoryMode): void {
		this.currentMemory = mode;
	}

	get enabledTools(): string[] {
		return this.toolPolicy.enabledNames();
	}

	get excludedTools(): string[] {
		return this.excludedToolNames;
	}

	get toolSchemaExcludedNames(): string[] {
		return this.toolPolicy.schemaExcludedNames();
	}

	isToolEnabled(name: string): boolean {
		return this.toolPolicy.isRuntimeAllowed(name);
	}

	/** Runtime gate for tools a sub-agent runs; expert mode never narrows it. */
	isDelegatedToolEnabled(name: string, model?: ModelRef): boolean {
		return this.delegatedToolPolicyFor(model).isRuntimeAllowed(name);
	}

	get toolPolicy(): ToolPolicy {
		return this.buildToolPolicy(this.isExpertModeEnabled);
	}

	/**
	 * The sub-agent's policy: it does implement, so it keeps the implementation
	 * tools and takes its allow/deny lists from the profile of the model it
	 * runs on rather than the planner's — the execution model by default, or
	 * the one a custom agent pins with `model:`. A Moonshot agent spawned from
	 * an OpenAI session must not inherit the OpenAI profile's
	 * `apply_patch`-instead-of-`edit` shape.
	 */
	delegatedToolPolicyFor(model?: ModelRef): ToolPolicy {
		return this.buildToolPolicy(
			false,
			model ? resolveModelProfile(model) : this.executionModelProfile,
		);
	}

	private buildToolPolicy(
		expertModeEnabled: boolean,
		modelProfile: ModelProfile = this.currentModelProfile,
	): ToolPolicy {
		return new ToolPolicy({
			profileTools: this.profile.tools,
			modelTools: modelProfile.tools,
			excludedTools: this.excludedToolNames,
			modelExcludedTools: modelProfile.excludedTools,
			computerUseEnabled: this.computerUseEnabled,
			browserUseEnabled: this.browserUseEnabled,
			skillDiscoveryEnabled: this.skillDiscoveryEnabled,
			expertModeEnabled,
		});
	}

	enableComputerUse(): void {
		this.computerUseEnabled = true;
	}

	setComputerUseEnabled(enabled: boolean): void {
		this.computerUseEnabled = enabled;
	}

	get isComputerUseEnabled(): boolean {
		return this.computerUseEnabled;
	}

	setSkillDiscoveryEnabled(enabled: boolean): void {
		this.skillDiscoveryEnabled = enabled;
	}

	get isSkillDiscoveryEnabled(): boolean {
		return this.skillDiscoveryEnabled;
	}

	enableBrowserUse(): void {
		this.browserUseEnabled = true;
	}

	setBrowserUseEnabled(enabled: boolean): void {
		this.browserUseEnabled = enabled;
	}

	get isBrowserUseEnabled(): boolean {
		return this.browserUseEnabled;
	}

	get isNotifyEnabled(): boolean {
		return this.notifyEnabled;
	}

	setNotifyEnabled(enabled: boolean): void {
		this.notifyEnabled = enabled;
	}

	get isVerbose(): boolean {
		return this.verboseEnabled;
	}

	setVerbose(enabled: boolean): void {
		this.verboseEnabled = enabled;
	}

	get memoryProfile(): MemoryProfile {
		return this.currentMemoryProfile;
	}

	getWorkspaceId(): string {
		this.workspaceId ??= qProjectWorkspaceId(this.cwd);
		return this.workspaceId;
	}

	get thinking(): ThinkingIntent | null | undefined {
		return this.currentThinking;
	}

	get thinkingIntent(): ThinkingIntent | null | undefined {
		return this.currentThinking;
	}

	get finalVerificationNudge(): boolean {
		return this.currentFinalVerificationNudge;
	}

	get fresh(): boolean {
		return this.flags.fresh ?? false;
	}

	setThinking(thinking: ThinkingIntent | null | undefined): void {
		this.currentThinking = thinking;
	}

	/** On only once a model is picked — expert mode with no model is a no-op. */
	get isExpertModeEnabled(): boolean {
		return this.expertEnabled && this.expertModelRef !== null;
	}

	get expertModel(): ModelRef | null {
		return this.expertModelRef;
	}

	/** The model that implements: the expert pick, else the `/model` selection. */
	get executionModel(): ModelRef {
		return this.isExpertModeEnabled && this.expertModelRef
			? this.expertModelRef
			: this.currentModel;
	}

	/** The profile of whichever model implements — it decides that model's tools. */
	get executionModelProfile(): ModelProfile {
		return this.isExpertModeEnabled && this.expertModelProfile
			? this.expertModelProfile
			: this.currentModelProfile;
	}

	get executionThinking(): ThinkingIntent | null | undefined {
		return this.isExpertModeEnabled
			? this.expertThinking
			: this.currentThinking;
	}

	/** Omitting `model` keeps the remembered pick, so off/on needs no re-pick. */
	setExpertMode(next: {
		enabled: boolean;
		model?: ModelRef | null;
		thinking?: ThinkingIntent | null | undefined;
	}): void {
		this.expertEnabled = next.enabled;
		if (next.model !== undefined) {
			this.expertModelRef = next.model;
			this.expertModelProfile = next.model
				? resolveModelProfile(next.model)
				: null;
		}
		if ("thinking" in next) this.expertThinking = next.thinking;
	}

	async saveRuntimeSelection(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				...(this.flags.model === undefined ? { model: this.currentModel } : {}),
				...(this.flags.thinking === undefined
					? { thinking: this.currentThinking }
					: {}),
				...(this.flags.memory === undefined
					? { memory: this.currentMemory }
					: {}),
				...(this.flags.memoryProfile === undefined
					? { memoryProfile: this.currentMemoryProfile }
					: {}),
			},
			this.persistedConfigHomeDir,
		);
	}

	async saveExpertPreference(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		const expert: ExpertConfig = { enabled: this.expertEnabled };
		if (this.expertModelRef) expert.model = this.expertModelRef;
		if (this.expertThinking !== undefined) {
			expert.thinking = this.expertThinking;
		}
		await saveBackboardConfig(
			{ ...existing, expert },
			this.persistedConfigHomeDir,
		);
	}

	async saveNotifyPreference(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				notify: this.notifyEnabled,
			},
			this.persistedConfigHomeDir,
		);
	}

	async saveVerbosePreference(): Promise<void> {
		const existing = readBackboardConfig(this.persistedConfigHomeDir);
		await saveBackboardConfig(
			{
				...existing,
				verbose: this.verboseEnabled,
			},
			this.persistedConfigHomeDir,
		);
	}

	get hasBackboardAuth(): boolean {
		return this.auth.backboard !== null;
	}

	get hasProviderKeys(): boolean {
		return this.auth.providerKeys.length > 0;
	}

	/**
	 * Re-reads credentials after `/login`, `/logout`, or a `/keys` change so the
	 * running session picks them up without a restart.
	 */
	refreshAuth(): AuthState {
		this.auth = resolveAuth(
			this.homeDir === undefined ? {} : { homeDir: this.homeDir },
		);
		const next = this.auth.backboard ?? anonymousEnv();
		this.env.apiKey = next.apiKey;
		this.env.apiUrl = next.apiUrl;
		return this.auth;
	}

	reloadEnv(): void {
		this.refreshAuth();
	}
}
