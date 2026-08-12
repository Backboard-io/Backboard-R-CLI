import { findRepoRoot } from "../../config/paths.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { TurnStatus } from "../bus/events.ts";
import { formatHookName, runCommandHook } from "./commandRunner.ts";
import { isToolHookEvent } from "./constants.ts";
import { matchesHook } from "./matcher.ts";
import type {
	HookBaseInput,
	HookEventName,
	HookInput,
	HookOutput,
	LoadedHook,
	PostToolUseHookInput,
	PostToolUseHookResult,
	PreToolUseHookInput,
	PreToolUseHookResult,
	SessionEndHookInput,
	SessionStartHookInput,
	StopHookInput,
	UserPromptHookResult,
	UserPromptSubmitHookInput,
} from "./types.ts";

export interface HookControllerOptions {
	hooks: readonly LoadedHook[];
	bus: EventBus;
	cwd: string;
	sessionId: string;
	projectDir?: string;
}

export class HookController {
	private hooks: readonly LoadedHook[];
	private readonly bus: EventBus;
	private readonly cwd: string;
	private sessionId: string;
	private readonly projectDir: string;
	private readonly sessionContext: string[] = [];

	constructor(options: HookControllerOptions) {
		this.hooks = options.hooks;
		this.bus = options.bus;
		this.cwd = options.cwd;
		this.sessionId = options.sessionId;
		this.projectDir = options.projectDir ?? findRepoRoot(options.cwd);
	}

	setSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	get baseContext(): string {
		return this.sessionContext.join("\n\n");
	}

	replaceHooks(hooks: readonly LoadedHook[]): void {
		this.hooks = hooks;
	}

	hasTrustedUserPromptHooks(): boolean {
		return this.hooks.some(
			(hook) => hook.trusted && hook.event === "UserPromptSubmit",
		);
	}

	hasTrustedToolHooksFor(toolName: string): boolean {
		return this.hooks.some(
			(hook) =>
				hook.trusted &&
				isToolHookEvent(hook.event) &&
				matchesHook(hook.matcher, toolName),
		);
	}

	async runSessionStart(
		source: SessionStartHookInput["source"],
		signal: AbortSignal,
	): Promise<void> {
		const input: SessionStartHookInput = {
			...this.baseInput(),
			hook_event_name: "SessionStart",
			source,
		};
		const outputs = await this.runMatchingHooks(
			"SessionStart",
			source,
			input,
			signal,
		);
		for (const output of outputs) {
			const denied = deniedReason(output);
			if (denied) {
				this.bus.emit({
					type: "system:warning",
					message: `SessionStart hook returned a block decision: ${denied}`,
				});
				continue;
			}
			const context = hookSpecificString(output, "additionalContext");
			if (context) this.sessionContext.push(context);
		}
	}

	async runStop(input: {
		turnId?: string;
		status?: TurnStatus;
		signal: AbortSignal;
	}): Promise<void> {
		const hookInput: StopHookInput = {
			...this.baseInput(),
			hook_event_name: "Stop",
			...(input.turnId ? { turn_id: input.turnId } : {}),
			...(input.status ? { status: input.status } : {}),
		};
		// Stop is terminal: run hooks for side effects; their output is dropped.
		await this.runMatchingHooks("Stop", "", hookInput, input.signal);
	}

	async runSessionEnd(
		reason: SessionEndHookInput["reason"],
		signal: AbortSignal,
	): Promise<void> {
		const hookInput: SessionEndHookInput = {
			...this.baseInput(),
			hook_event_name: "SessionEnd",
			reason,
		};
		await this.runMatchingHooks("SessionEnd", reason, hookInput, signal);
	}

	async runUserPromptSubmit(input: {
		turnId: string;
		prompt: string;
		signal: AbortSignal;
	}): Promise<UserPromptHookResult> {
		const hookInput: UserPromptSubmitHookInput = {
			...this.baseInput(),
			hook_event_name: "UserPromptSubmit",
			turn_id: input.turnId,
			prompt: input.prompt,
		};
		const outputs = await this.runMatchingHooks(
			"UserPromptSubmit",
			"",
			hookInput,
			input.signal,
		);
		const additionalContext: string[] = [];
		for (const output of outputs) {
			const denied = deniedReason(output);
			if (denied) return { blockedReason: denied };
			const context = hookSpecificString(output, "additionalContext");
			if (context) additionalContext.push(context);
		}
		const ctx = joinHookContext(...additionalContext);
		return {
			...(ctx ? { additionalContext: ctx } : {}),
		};
	}

	async runPreToolUse(input: {
		turnId?: string;
		sessionId?: string;
		cwd?: string;
		toolCallId: string;
		toolName: string;
		toolInput: unknown;
		signal: AbortSignal;
	}): Promise<PreToolUseHookResult> {
		const hookInput: PreToolUseHookInput = {
			...this.baseInput({ sessionId: input.sessionId, cwd: input.cwd }),
			hook_event_name: "PreToolUse",
			...(input.turnId ? { turn_id: input.turnId } : {}),
			tool_use_id: input.toolCallId,
			tool_name: input.toolName,
			tool_input: input.toolInput,
		};
		const outputs = await this.runMatchingHooks(
			"PreToolUse",
			input.toolName,
			hookInput,
			input.signal,
		);
		let nextInput = input.toolInput;
		const additionalContext: string[] = [];
		for (const output of outputs) {
			const denied = deniedReason(output);
			if (denied) return { input: nextInput, deniedReason: denied };
			const updatedInput = hookSpecificValue(output, "updatedInput");
			if (updatedInput !== undefined) nextInput = updatedInput;
			const context = hookSpecificString(output, "additionalContext");
			if (context) additionalContext.push(context);
		}
		const ctx = joinHookContext(...additionalContext);
		return {
			input: nextInput,
			...(ctx ? { additionalContext: ctx } : {}),
		};
	}

	async runPostToolUse(input: {
		turnId?: string;
		sessionId?: string;
		cwd?: string;
		toolCallId: string;
		toolName: string;
		toolInput: unknown;
		output: string;
		isError: boolean;
		signal: AbortSignal;
	}): Promise<PostToolUseHookResult> {
		const hookInput: PostToolUseHookInput = {
			...this.baseInput({ sessionId: input.sessionId, cwd: input.cwd }),
			hook_event_name: "PostToolUse",
			...(input.turnId ? { turn_id: input.turnId } : {}),
			tool_use_id: input.toolCallId,
			tool_name: input.toolName,
			tool_input: input.toolInput,
			tool_response: {
				output: input.output,
				error: input.isError,
			},
		};
		const outputs = await this.runMatchingHooks(
			"PostToolUse",
			input.toolName,
			hookInput,
			input.signal,
		);
		let output = input.output;
		let denied = false;
		const additionalContext: string[] = [];
		for (const hookOutput of outputs) {
			const reason = deniedReason(hookOutput);
			if (reason) {
				output = `Error: ${reason}`;
				denied = true;
				continue;
			}
			const replacement = hookSpecificString(hookOutput, "replacementOutput");
			if (replacement !== undefined) output = replacement;
			const context = hookSpecificString(hookOutput, "additionalContext");
			if (context) additionalContext.push(context);
		}
		const ctx = joinHookContext(...additionalContext);
		return {
			output,
			...(ctx ? { additionalContext: ctx } : {}),
			...(denied ? { denied: true } : {}),
		};
	}

	private baseInput(
		overrides: { sessionId?: string; cwd?: string } = {},
	): Omit<HookBaseInput, "hook_event_name"> {
		return {
			session_id: overrides.sessionId ?? this.sessionId,
			cwd: overrides.cwd ?? this.cwd,
			timestamp: new Date().toISOString(),
		};
	}

	private async runMatchingHooks(
		event: HookEventName,
		matcherValue: string,
		input: HookInput,
		signal: AbortSignal,
	): Promise<HookOutput[]> {
		// Matchers only apply to tool events; for other events a matcher in
		// config would test against an empty value and silently drop the hook.
		const matcherApplies = isToolHookEvent(event);
		const matching = this.hooks.filter(
			(hook) =>
				hook.trusted &&
				hook.event === event &&
				(!matcherApplies || matchesHook(hook.matcher, matcherValue)),
		);
		const outputs: HookOutput[] = [];
		for (const hook of matching) {
			if (signal.aborted) break;
			const result = await runCommandHook(hook, input, {
				cwd: input.cwd,
				projectDir: this.projectDir,
				sessionId: input.session_id,
				signal,
			});
			if (result.stderr.trim()) {
				this.bus.emit({
					type: "system:warning",
					message: `${formatHookName(hook)} stderr: ${result.stderr.trim()}`,
				});
			}
			if (result.status === "warning") {
				this.bus.emit({ type: "system:warning", message: result.warning });
				continue;
			}
			if (result.status === "blocked") {
				outputs.push({ decision: "deny", reason: result.reason });
				break;
			}
			if (result.output.systemMessage) {
				this.bus.emit({
					type: "system:warning",
					message: result.output.systemMessage,
				});
			}
			outputs.push(result.output);
			if (deniedReason(result.output)) break;
		}
		return outputs;
	}
}

export function joinHookContext(
	...parts: Array<string | undefined>
): string | undefined {
	const filtered = parts.filter(
		(part): part is string =>
			typeof part === "string" && part.trim().length > 0,
	);
	return filtered.length > 0 ? filtered.join("\n\n") : undefined;
}

function deniedReason(output: HookOutput): string | undefined {
	if (
		output.decision === "deny" ||
		output.decision === "block" ||
		output.continue === false
	) {
		return output.reason ?? output.stopReason ?? "Blocked by hook";
	}
	// Claude Code PreToolUse nested form: hookSpecificOutput.permissionDecision.
	if (hookSpecificValue(output, "permissionDecision") === "deny") {
		return (
			hookSpecificString(output, "permissionDecisionReason") ??
			"Blocked by hook"
		);
	}
	return undefined;
}

function hookSpecificValue(output: HookOutput, key: string): unknown {
	return output.hookSpecificOutput?.[key];
}

function hookSpecificString(
	output: HookOutput,
	key: string,
): string | undefined {
	const value = hookSpecificValue(output, key);
	return typeof value === "string" ? value : undefined;
}
