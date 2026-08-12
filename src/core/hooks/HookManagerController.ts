import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import type { HookConfigPaths } from "../../config/paths.ts";
import { loadHookConfig } from "./config.ts";
import { type AddHookInput, addHook, removeHook } from "./configWrite.ts";
import { HOOK_EVENT_NAMES } from "./constants.ts";
import type { HookEventName, LoadedHook, LoadedHookConfig } from "./types.ts";

export interface HookEventSummary {
	event: HookEventName;
	description: string;
	total: number;
	trusted: number;
	untrusted: number;
}

export interface HookManagerSnapshot {
	events: HookEventSummary[];
	hooks: LoadedHook[];
	warnings: string[];
	paths: HookConfigPaths;
}

interface HookManagerDeps {
	applyHooks?: (hooks: LoadedHook[]) => void;
}

export class HookManagerController {
	private readonly applyHooks?: (hooks: LoadedHook[]) => void;

	constructor(
		private readonly paths: HookConfigPaths,
		deps: HookManagerDeps = {},
	) {
		this.applyHooks = deps.applyHooks;
	}

	snapshot(): HookManagerSnapshot {
		return snapshotFromLoaded(this.paths, loadHookConfig(this.paths));
	}

	async addHook(input: AddHookInput): Promise<HookManagerSnapshot> {
		await addHook(this.paths, input);
		return this.reloadAndApply();
	}

	async removeHook(hook: LoadedHook): Promise<HookManagerSnapshot> {
		await removeHook(this.paths, hook);
		return this.reloadAndApply();
	}

	private reloadAndApply(): HookManagerSnapshot {
		const loaded = loadHookConfig(this.paths);
		this.applyHooks?.(loaded.hooks);
		return snapshotFromLoaded(this.paths, loaded);
	}
}

function snapshotFromLoaded(
	paths: HookConfigPaths,
	loaded: LoadedHookConfig,
): HookManagerSnapshot {
	return {
		events: HOOK_EVENT_NAMES.map((event) => eventSummary(event, loaded.hooks)),
		hooks: [...loaded.hooks],
		warnings: [...loaded.warnings],
		paths,
	};
}

function eventSummary(
	event: HookEventName,
	hooks: readonly LoadedHook[],
): HookEventSummary {
	const matching = hooks.filter((hook) => hook.event === event);
	return {
		event,
		description: hookEventDescription(event),
		total: matching.length,
		trusted: matching.filter((hook) => hook.trusted).length,
		untrusted: matching.filter((hook) => !hook.trusted).length,
	};
}

function hookEventDescription(event: HookEventName): string {
	switch (event) {
		case "SessionStart":
			return `Run when a ${APP_DISPLAY_NAME} session starts`;
		case "UserPromptSubmit":
			return "Run when a user submits a prompt";
		case "PreToolUse":
			return "Run before tool execution";
		case "PostToolUse":
			return "Run after tool execution";
		case "Stop":
			return "Run when the agent finishes a turn";
		case "SessionEnd":
			return `Run when a ${APP_DISPLAY_NAME} session ends`;
	}
}
