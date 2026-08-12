export type SkillSource = "repo" | "user";

export interface Skill {
	name: string;
	description: string;
	body: string;
	dir: string;
	path: string;
	source: SkillSource;
}
