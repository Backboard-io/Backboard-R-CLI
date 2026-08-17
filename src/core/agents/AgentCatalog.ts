import type { AgentDefinition } from "./AgentDefinition.ts";

/**
 * The resolved set of agents `subagent_type` accepts. Callers pass definitions
 * in precedence order (project, then user, then built-in); the catalog keeps
 * the first entry for each name and drops the rest, so lookups, `names`, and
 * `promptCatalog` always agree.
 */
export class AgentCatalog {
	readonly agents: readonly AgentDefinition[];
	readonly warnings: readonly string[];
	private readonly byName: ReadonlyMap<string, AgentDefinition>;

	constructor(
		agents: readonly AgentDefinition[],
		warnings: readonly string[] = [],
	) {
		const byName = new Map<string, AgentDefinition>();
		for (const agent of agents) {
			if (!byName.has(agent.name)) byName.set(agent.name, agent);
		}
		this.agents = [...byName.values()];
		this.warnings = warnings;
		this.byName = byName;
	}

	get(name: string): AgentDefinition | undefined {
		return this.byName.get(name);
	}

	get names(): string[] {
		return this.agents.map((agent) => agent.name);
	}

	/** Markdown list injected into the Agent tool description. */
	get promptCatalog(): string {
		return this.agents
			.map((agent) => `- \`${agent.name}\`: ${agent.description}`)
			.join("\n");
	}
}
