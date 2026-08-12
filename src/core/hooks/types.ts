import type { TurnStatus } from "../bus/events.ts";
import type { HOOK_EVENT_NAMES } from "./constants.ts";

export type { HookConfigPaths } from "../../config/paths.ts";

export type HookEventName = (typeof HOOK_EVENT_NAMES)[number];
export type HookSourceKind = "project" | "user";

export interface CommandHookConfig {
	type: "command";
	command: string;
	name?: string;
	timeoutMs?: number;
}

export interface HookGroupConfig {
	matcher?: string;
	hooks: CommandHookConfig[];
}

export type HooksByEvent = Partial<Record<HookEventName, HookGroupConfig[]>>;

export interface HookConfigFile {
	trustedProjectHookHashes?: string[];
	hooks?: HooksByEvent;
}

export interface HookSource {
	kind: HookSourceKind;
	path: string;
}

export interface LoadedHook {
	event: HookEventName;
	matcher?: string;
	hook: CommandHookConfig;
	source: HookSource;
	hash: string;
	trusted: boolean;
}

export interface LoadedHookConfig {
	hooks: LoadedHook[];
	trustedProjectHookHashes: string[];
	warnings: string[];
}

export interface HookBaseInput {
	session_id: string;
	cwd: string;
	hook_event_name: HookEventName;
	timestamp: string;
}

export interface SessionStartHookInput extends HookBaseInput {
	hook_event_name: "SessionStart";
	source: "startup";
}

export interface UserPromptSubmitHookInput extends HookBaseInput {
	hook_event_name: "UserPromptSubmit";
	turn_id: string;
	prompt: string;
}

export interface PreToolUseHookInput extends HookBaseInput {
	hook_event_name: "PreToolUse";
	turn_id?: string;
	tool_use_id: string;
	tool_name: string;
	tool_input: unknown;
}

export interface PostToolUseHookInput extends HookBaseInput {
	hook_event_name: "PostToolUse";
	turn_id?: string;
	tool_use_id: string;
	tool_name: string;
	tool_input: unknown;
	tool_response: {
		output: string;
		error: boolean;
	};
}

export interface StopHookInput extends HookBaseInput {
	hook_event_name: "Stop";
	turn_id?: string;
	status?: TurnStatus;
}

export interface SessionEndHookInput extends HookBaseInput {
	hook_event_name: "SessionEnd";
	reason: "exit";
}

export type HookInput =
	| SessionStartHookInput
	| UserPromptSubmitHookInput
	| PreToolUseHookInput
	| PostToolUseHookInput
	| StopHookInput
	| SessionEndHookInput;

export interface HookOutput {
	systemMessage?: string;
	decision?: "allow" | "deny" | "block";
	reason?: string;
	continue?: boolean;
	stopReason?: string;
	hookSpecificOutput?: Record<string, unknown>;
}

export interface UserPromptHookResult {
	blockedReason?: string;
	additionalContext?: string;
}

export interface PreToolUseHookResult {
	input: unknown;
	deniedReason?: string;
	additionalContext?: string;
}

export interface PostToolUseHookResult {
	output: string;
	additionalContext?: string;
	// A PostToolUse hook turned the result into an error (deny/block).
	denied?: boolean;
}
