import { type Dirent, existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { findRepoRoot } from "../../config/paths.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { Skill, SkillSource } from "./Skill.ts";
import { buildSkillCatalog, type SkillCatalog } from "./SkillCatalog.ts";

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export interface DiscoverSkillsOptions {
	cwd: string;
	homeDir?: string;
	includeRepoSkills?: boolean;
	includeUserSkills?: boolean;
}

interface LoadResult {
	skill?: Skill;
	warning?: string;
}

export async function discoverSkills(
	options: DiscoverSkillsOptions,
): Promise<SkillCatalog> {
	const cwd = path.resolve(options.cwd);
	const warnings: string[] = [];
	const skills: Skill[] = [];
	const seen = new Map<string, Skill>();

	const add = (result: LoadResult): void => {
		if (result.warning) warnings.push(result.warning);
		if (!result.skill) return;
		const existing = seen.get(result.skill.name);
		if (existing) {
			warnings.push(
				`Skipped duplicate skill '${result.skill.name}' at ${result.skill.path}; already loaded from ${existing.path}.`,
			);
			return;
		}
		seen.set(result.skill.name, result.skill);
		skills.push(result.skill);
	};

	if (options.includeRepoSkills !== false) {
		for (const root of repoSkillRoots(cwd)) {
			for (const result of await loadSkillRoot(root, "repo")) add(result);
		}
	}

	if (options.includeUserSkills !== false) {
		const userRoot = path.join(
			options.homeDir ?? os.homedir(),
			".agents",
			"skills",
		);
		for (const result of await loadSkillRoot(userRoot, "user")) add(result);
	}

	return buildSkillCatalog(skills, { warnings });
}

export function loadSkillFromMarkdown(
	content: string,
	dirName: string,
	filePath: string,
	source: SkillSource,
): LoadResult {
	const parsed = FRONTMATTER_PATTERN.exec(content);
	if (!parsed) {
		return {
			warning: `Skipped skill at ${filePath}: missing YAML frontmatter.`,
		};
	}

	const yaml = parsed[1] ?? "";
	const body = parsed[2] ?? "";
	const doc = parseDocument(yaml);
	if (doc.errors.length > 0) {
		return {
			warning: `Skipped skill at ${filePath}: invalid YAML frontmatter.`,
		};
	}

	const data = doc.toJSON() as unknown;
	if (!isRecord(data)) {
		return {
			warning: `Skipped skill at ${filePath}: frontmatter must be a map.`,
		};
	}

	const name = stringValue(data.name);
	if (!name) {
		return { warning: `Skipped skill at ${filePath}: missing name.` };
	}
	if (name.length > MAX_SKILL_NAME_LENGTH || !SKILL_NAME_PATTERN.test(name)) {
		return { warning: `Skipped skill at ${filePath}: invalid skill name.` };
	}
	if (name !== dirName) {
		return {
			warning: `Skipped skill at ${filePath}: name must match directory '${dirName}'.`,
		};
	}

	const description = stringValue(data.description);
	if (!description) {
		return { warning: `Skipped skill at ${filePath}: missing description.` };
	}
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return {
			warning: `Skipped skill at ${filePath}: description exceeds 1024 characters.`,
		};
	}

	return {
		skill: {
			name,
			description,
			body: body.trim(),
			dir: path.dirname(filePath),
			path: filePath,
			source,
		},
	};
}

async function loadSkillRoot(
	root: string,
	source: SkillSource,
): Promise<LoadResult[]> {
	if (!existsSync(root)) return [];
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		return [{ warning: `Skipped skills root ${root}: ${errorMessage(err)}.` }];
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const results: LoadResult[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (source === "repo" && entry.isSymbolicLink()) {
			results.push({
				warning: `Skipped symlinked repo skill directory ${path.join(root, entry.name)}.`,
			});
			continue;
		}
		const dir = path.join(root, entry.name);
		try {
			const info = await stat(dir);
			if (!info.isDirectory()) continue;
			const skillPath = path.join(dir, "SKILL.md");
			if (!existsSync(skillPath)) continue;
			const content = await readFile(skillPath, "utf8");
			results.push(
				loadSkillFromMarkdown(content, entry.name, skillPath, source),
			);
		} catch (err) {
			results.push({
				warning: `Skipped skill at ${dir}: ${errorMessage(err)}.`,
			});
		}
	}
	return results;
}

function repoSkillRoots(cwd: string): string[] {
	const root = findRepoRoot(cwd);
	const roots: string[] = [];
	let current = cwd;
	while (true) {
		roots.push(path.join(current, ".agents", "skills"));
		if (current === root) break;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return roots;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
