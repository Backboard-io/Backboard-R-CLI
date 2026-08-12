import type { SkillCatalog } from "../../core/skills/SkillCatalog.ts";

export function buildSkillCatalogPrompt(catalog?: SkillCatalog): string {
	if (!catalog?.promptCatalog.trim()) return "";
	return `
Skills are available. Catalog entries are names and descriptions only. Full instructions appear only after $skill-name activation. Do not invent skill instructions not shown.

Available skills:
${catalog.promptCatalog}
`.trim();
}

export async function buildActivatedSkillsPrompt(
	catalog: SkillCatalog | undefined,
	names: readonly string[],
): Promise<string> {
	if (!catalog || names.length === 0) return "";

	const sections: string[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);

		const skill = catalog.get(name);
		if (!skill) continue;
		sections.push(
			formatSkillSection(
				skill.name,
				skill.body,
				skill.dir,
				await catalog.bundledFiles(skill.name),
			),
		);
	}

	if (sections.length === 0) return "";
	return ["Activated skill instructions:", ...sections].join("\n\n");
}

function formatSkillSection(
	name: string,
	body: string,
	dir: string,
	bundledFiles: string[],
): string {
	if (bundledFiles.length === 0) return [`# Skill: ${name}`, body].join("\n\n");
	return [
		`# Skill: ${name}`,
		body,
		[
			`Bundled files (relative to ${dir}):`,
			...bundledFiles.map((file) => `- ${file}`),
		].join("\n"),
	].join("\n\n");
}
