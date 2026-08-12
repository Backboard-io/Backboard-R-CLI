import type { PermissionMode } from "./PermissionMode.ts";
import type { RuleSet } from "./PermissionRules.ts";

/**
 * A tool's own verdict on a call. `undefined` (from Tool.checkPermissions)
 * means "no opinion" — the engine keeps evaluating.
 */
export type PermissionDecision =
	| { behavior: "allow"; reason: string }
	| { behavior: "deny"; reason: string };

/** What a tool sees when asked for its verdict. */
export interface PermissionCheckContext {
	mode: PermissionMode;
	cwd: string;
	/** False in headless mode and sub-agents: nobody is there to prompt. */
	interactive: boolean;
}

/**
 * Session permission state, carried on ToolContext. AgentController owns one
 * mutable instance; mode cycling mutates `mode` in place.
 */
export interface PermissionContext {
	mode: PermissionMode;
	rules: RuleSet;
	/** False in headless mode and sub-agents: an `ask` auto-denies. */
	interactive: boolean;
}
