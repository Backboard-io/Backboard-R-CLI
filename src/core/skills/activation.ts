import type { SkillCatalog } from "./SkillCatalog.ts";

const SKILL_INVOCATION_PATTERN =
	/(^|[^A-Za-z0-9_$])\$([a-z0-9-]{1,64})(?=$|[^A-Za-z0-9-])/g;

export function extractSkillInvocations(
	text: string,
	catalog: SkillCatalog,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();

	for (const match of text.matchAll(SKILL_INVOCATION_PATTERN)) {
		const name = match[2];
		if (!name || seen.has(name) || !catalog.get(name)) continue;
		seen.add(name);
		names.push(name);
	}

	return names;
}
