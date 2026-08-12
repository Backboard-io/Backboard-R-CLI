export type SkillPickerSource = "repo" | "personal" | "skills-sh";

export type SkillInstallTarget = "repo" | "personal";

export interface SkillPickerItem {
	id: string;
	name: string;
	description: string;
	source: SkillPickerSource;
	active?: boolean;
	detail?: string;
	installs?: string;
}

export interface SkillPickerTab {
	id: SkillPickerSource;
	label: string;
	items: SkillPickerItem[];
	error?: string;
}
