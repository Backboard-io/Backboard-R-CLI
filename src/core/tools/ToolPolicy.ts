import type { PromptProfileId } from "../../prompts/profiles/ids.ts";
import { canonicalToolName } from "./names.ts";
import type { OpenAITool } from "./schema.ts";
import type { Tool } from "./Tool.ts";
import type { ToolRegistry } from "./ToolRegistry.ts";
import {
	combineToolAllowlists,
	combineToolExclusions,
	isAllowedByToolList,
} from "./toolLists.ts";

export interface ToolPolicySnapshot {
	profileTools: readonly string[];
	modelTools: readonly string[];
	excludedTools: readonly string[];
	modelExcludedTools?: readonly string[];
	computerUseEnabled: boolean;
	browserUseEnabled: boolean;
	skillDiscoveryEnabled: boolean;
	/**
	 * Expert mode, on the parent policy only. Implementation moves to the
	 * expert model, so the parent loses the tools that would let it implement
	 * inline and has to delegate through the Agent tool instead.
	 */
	expertModeEnabled?: boolean;
}

const SKILL_DISCOVERY_TOOLS = ["find_skill", "find_mcp"];

/** Withheld from the parent while expert mode is on; sub-agents keep them. */
export const EXPERT_EXECUTION_TOOLS: readonly string[] = [
	"edit",
	"write",
	"apply_patch",
	"execute",
];

export class ToolPolicy {
	private readonly allowedTools: string[];
	private readonly excludedToolNames: string[];

	constructor(private readonly snapshot: ToolPolicySnapshot) {
		this.allowedTools = combineToolAllowlists(
			snapshot.profileTools,
			snapshot.modelTools,
		);
		this.excludedToolNames = combineToolExclusions(
			snapshot.excludedTools,
			snapshot.modelExcludedTools ?? [],
			snapshot.expertModeEnabled ? EXPERT_EXECUTION_TOOLS : [],
		);
	}

	enabledNames(): string[] {
		if (this.allowedTools.length === 0) return [];
		return this.allowedTools.filter(
			(name) => !this.excludedToolNames.includes(name),
		);
	}

	excludedNames(): string[] {
		return [...this.excludedToolNames];
	}

	schemaExcludedNames(): string[] {
		const excluded = new Set(this.excludedToolNames);
		if (!this.snapshot.computerUseEnabled) excluded.add("computer");
		if (!this.snapshot.browserUseEnabled) excluded.add("browser");
		if (!this.snapshot.skillDiscoveryEnabled) {
			for (const name of SKILL_DISCOVERY_TOOLS) excluded.add(name);
		}
		return [...excluded];
	}

	isRuntimeAllowed(name: string): boolean {
		const canonicalName = canonicalToolName(name);
		if (canonicalName === "computer" && !this.snapshot.computerUseEnabled) {
			return false;
		}
		if (canonicalName === "browser" && !this.snapshot.browserUseEnabled) {
			return false;
		}
		if (
			SKILL_DISCOVERY_TOOLS.includes(canonicalName) &&
			!this.snapshot.skillDiscoveryEnabled
		) {
			return false;
		}
		if (this.excludedToolNames.includes(canonicalName)) return false;
		return (
			isAllowedByToolList(canonicalName, this.snapshot.profileTools) &&
			isAllowedByToolList(canonicalName, this.snapshot.modelTools)
		);
	}

	visibleTools(
		registry: ToolRegistry,
		extraExcluded: readonly string[] = [],
	): Tool[] {
		const extra = new Set(extraExcluded.map(canonicalToolName));
		return registry
			.list()
			.filter(
				(tool) =>
					this.isRuntimeAllowed(tool.agentName) && !extra.has(tool.agentName),
			);
	}

	visibleSchemas(
		registry: ToolRegistry,
		extraExcluded: readonly string[] = [],
		profile?: PromptProfileId,
	): OpenAITool[] {
		return registry.toJSONSchemasFor(
			this.visibleTools(registry, extraExcluded),
			profile,
		);
	}
}
