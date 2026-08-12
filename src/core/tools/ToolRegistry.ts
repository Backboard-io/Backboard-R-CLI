import type { PromptProfileId } from "../../prompts/profiles/ids.ts";
import { detectCommandShell } from "../../utils/commandShell.ts";
import { canonicalToolName } from "./names.ts";
import type { OpenAITool } from "./schema.ts";
import type { Tool } from "./Tool.ts";

/**
 * Holds the active tool set and produces the OpenAI-schema array sent to
 * Backboard on every turn. Lookups are by model-facing tool name.
 */
export class ToolRegistry {
	private readonly tools = new Map<string, Tool>();

	constructor(tools: Tool[] = []) {
		for (const tool of tools) this.register(tool);
	}

	register(tool: Tool): void {
		if (this.tools.has(tool.agentName)) {
			throw new Error(`Tool already registered: ${tool.agentName}`);
		}
		this.tools.set(tool.agentName, tool);
	}

	unregister(name: string): boolean {
		return this.tools.delete(canonicalToolName(name));
	}

	get(name: string): Tool | undefined {
		return this.tools.get(canonicalToolName(name));
	}

	has(name: string): boolean {
		return this.tools.has(canonicalToolName(name));
	}

	list(): Tool[] {
		return [...this.tools.values()];
	}

	/** Optionally restrict to a subset by name. Empty subset means "all". */
	filtered(names: string[], excluded: string[] = []): Tool[] {
		const blocked = new Set(excluded.map(canonicalToolName));
		if (names.length === 0)
			return this.list().filter((tool) => !blocked.has(tool.agentName));
		return names
			.map((n) => this.tools.get(canonicalToolName(n)))
			.filter((t): t is Tool => t !== undefined && !blocked.has(t.agentName));
	}

	toJSONSchemas(names: string[] = [], excluded: string[] = []): OpenAITool[] {
		const tools = this.filtered(names, excluded);
		return this.toJSONSchemasFor(tools);
	}

	toJSONSchemasFor(
		tools: readonly Tool[],
		profile?: PromptProfileId,
	): OpenAITool[] {
		const enabledTools = tools.map((tool) => tool.agentName);
		const commandShell = detectCommandShell();
		return tools.map((tool) =>
			tool.toJSONSchema({
				enabledTools,
				commandShellKind: commandShell.kind,
				commandShellPath: commandShell.path,
				profile,
			}),
		);
	}
}
