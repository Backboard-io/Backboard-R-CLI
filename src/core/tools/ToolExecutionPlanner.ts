import { errorMessage } from "../../utils/errors.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { HookController } from "../hooks/index.ts";
import type { Tool } from "./Tool.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";

export interface ErrorPlanEntry {
	ref: ToolCallRef;
	errorOutput: string;
	concurrencySafe: false;
	displayName?: string;
}

export interface ExecutablePlanEntry {
	ref: ToolCallRef;
	tool: Tool;
	input: unknown;
	concurrencySafe: boolean;
}

export type PlanEntry = ErrorPlanEntry | ExecutablePlanEntry;

export class ToolExecutionPlanner {
	constructor(
		private readonly registry: ToolRegistry,
		private readonly isToolEnabled: (name: string) => boolean,
		private readonly hookController?: HookController,
	) {}

	build(calls: ToolCallRef[]): PlanEntry[] {
		return calls.map((ref) => {
			const tool = this.registry.get(ref.name);
			if (!tool) {
				return {
					ref,
					errorOutput: `Error: unknown tool "${ref.name}"`,
					concurrencySafe: false,
				};
			}
			if (!this.isToolEnabled(ref.name)) {
				return {
					ref,
					errorOutput: `Error: tool "${ref.name}" is disabled`,
					concurrencySafe: false,
					displayName: tool.displayName,
				};
			}
			try {
				const input = tool.parseInput(ref.input);
				// Trusted hooks force serial execution AND (via the round's
				// concurrency gate) block early start: user hook commands must
				// fire exactly once per call id, and a discarded early run
				// would replay them. Untrusted hooks never execute at all.
				const hasMatchingToolHooks =
					this.hookController?.hasTrustedToolHooksFor(ref.name) ?? false;
				return {
					ref,
					tool,
					input,
					concurrencySafe:
						!hasMatchingToolHooks && tool.isConcurrencySafe(input),
				};
			} catch (err) {
				return {
					ref,
					errorOutput: `Error: invalid arguments for "${ref.name}": ${errorMessage(err)}`,
					concurrencySafe: false,
					displayName: tool.displayName,
				};
			}
		});
	}
}
