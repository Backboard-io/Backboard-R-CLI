import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { qProjectAgentsDir, qUserAgentsDir } from "../../config/paths.ts";
import { errorMessage } from "../../utils/errors.ts";
import { AgentCatalog } from "./AgentCatalog.ts";
import type { AgentDefinition, AgentSource } from "./AgentDefinition.ts";
import { BUILT_IN_AGENTS } from "./builtin.ts";
import { type AgentLoadResult, parseAgentFromMarkdown } from "./parse.ts";

export interface DiscoverAgentsOptions {
	cwd: string;
	homeDir?: string;
	includeProjectAgents?: boolean;
	includeUserAgents?: boolean;
}

/**
 * Loads `<repo>/.backboard/agents/*.md` then `~/.backboard/agents/*.md`.
 * Project files shadow user files of the same name; both shadow built-ins.
 */
export async function discoverAgents(
	options: DiscoverAgentsOptions,
): Promise<AgentCatalog> {
	const warnings: string[] = [];
	const agents: AgentDefinition[] = [];
	const seen = new Map<string, AgentDefinition>();

	const add = (result: AgentLoadResult): void => {
		if (result.warning) warnings.push(result.warning);
		if (!result.agent) return;
		const existing = seen.get(result.agent.name);
		if (existing) {
			warnings.push(
				`Skipped duplicate agent '${result.agent.name}' at ${result.agent.path}; already loaded from ${existing.path ?? existing.source}.`,
			);
			return;
		}
		seen.set(result.agent.name, result.agent);
		agents.push(result.agent);
	};

	if (options.includeProjectAgents !== false) {
		const root = qProjectAgentsDir(path.resolve(options.cwd));
		for (const result of await loadAgentRoot(root, "project")) add(result);
	}

	if (options.includeUserAgents !== false) {
		const root = qUserAgentsDir(options.homeDir);
		for (const result of await loadAgentRoot(root, "user")) add(result);
	}

	for (const builtIn of BUILT_IN_AGENTS) {
		if (seen.has(builtIn.name)) continue;
		seen.set(builtIn.name, builtIn);
		agents.push(builtIn);
	}

	return new AgentCatalog(agents, warnings);
}

async function loadAgentRoot(
	root: string,
	source: AgentSource,
): Promise<AgentLoadResult[]> {
	if (!existsSync(root)) return [];

	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		return [{ warning: `Skipped agents root ${root}: ${errorMessage(err)}.` }];
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const results: AgentLoadResult[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const filePath = path.join(root, entry.name);
		try {
			const content = await readFile(filePath, "utf8");
			results.push(
				parseAgentFromMarkdown(
					content,
					path.basename(entry.name, ".md"),
					filePath,
					source,
				),
			);
		} catch (err) {
			results.push({
				warning: `Skipped agent at ${filePath}: ${errorMessage(err)}.`,
			});
		}
	}
	return results;
}
