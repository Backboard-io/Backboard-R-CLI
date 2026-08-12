import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { truncate } from "../../utils/string.ts";
import type { Skill } from "./Skill.ts";

export const DEFAULT_SKILL_CATALOG_BUDGET = 8000;
const SHORT_DESCRIPTION_LIMIT = 160;

export interface SkillCatalogOptions {
	budget?: number;
	warnings?: string[];
}

export class SkillCatalog {
	readonly skills: readonly Skill[];
	readonly warnings: readonly string[];
	readonly promptCatalog: string;
	readonly omittedFromPrompt: readonly string[];

	constructor(
		skills: readonly Skill[],
		promptCatalog: string,
		warnings: readonly string[],
		omittedFromPrompt: readonly string[],
	) {
		this.skills = skills;
		this.promptCatalog = promptCatalog;
		this.warnings = warnings;
		this.omittedFromPrompt = omittedFromPrompt;
	}

	get(name: string): Skill | undefined {
		return this.skills.find((skill) => skill.name === name);
	}

	get skillNames(): string[] {
		return this.skills.map((skill) => skill.name);
	}

	async bundledFiles(name: string): Promise<string[]> {
		const skill = this.get(name);
		if (!skill) return [];
		return collectBundledFiles(skill.dir);
	}
}

export function buildSkillCatalog(
	skills: readonly Skill[],
	options: SkillCatalogOptions = {},
): SkillCatalog {
	const budget = options.budget ?? DEFAULT_SKILL_CATALOG_BUDGET;
	const baseWarnings = [...(options.warnings ?? [])];
	const fullEntries = skills.map((skill) => entry(skill));
	const fullCatalog = fullEntries.join("\n");

	if (fullCatalog.length <= budget) {
		return new SkillCatalog(skills, fullCatalog, baseWarnings, []);
	}

	const shortenedEntries = skills.map((skill) =>
		entry(skill, truncate(skill.description, SHORT_DESCRIPTION_LIMIT)),
	);
	const shortenedCatalog = shortenedEntries.join("\n");
	if (shortenedCatalog.length <= budget) {
		return new SkillCatalog(skills, shortenedCatalog, baseWarnings, []);
	}

	const kept: string[] = [];
	const omitted: string[] = [];
	let used = 0;
	for (let i = 0; i < skills.length; i++) {
		const line = shortenedEntries[i];
		const skill = skills[i];
		if (!line || !skill) continue;
		const nextUsed = used === 0 ? line.length : used + 1 + line.length;
		if (nextUsed <= budget) {
			kept.push(line);
			used = nextUsed;
		} else {
			omitted.push(skill.name);
		}
	}

	const warnings =
		omitted.length === 0
			? baseWarnings
			: [
					...baseWarnings,
					`Skill catalog omitted ${omitted.length} skill(s) to fit the prompt budget: ${omitted.join(", ")}`,
				];

	return new SkillCatalog(skills, kept.join("\n"), warnings, omitted);
}

function entry(skill: Skill, description = skill.description): string {
	return `- ${skill.name}: ${description}`;
}

async function collectBundledFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	const seen = new Set<string>();
	await collect(dir, dir, files, seen);
	return files.sort();
}

async function collect(
	root: string,
	dir: string,
	files: string[],
	seen: Set<string>,
): Promise<void> {
	const resolved = await realpath(dir);
	if (seen.has(resolved)) return;
	seen.add(resolved);

	const entries = await readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));

	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relative = path.relative(root, fullPath).split(path.sep).join("/");
		if (relative === "SKILL.md") continue;

		const info = await stat(fullPath);
		if (info.isDirectory()) {
			await collect(root, fullPath, files, seen);
		} else if (info.isFile()) {
			files.push(relative);
		}
	}
}
