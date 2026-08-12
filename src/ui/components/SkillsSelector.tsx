import type React from "react";
import type {
	SkillPickerItem,
	SkillPickerTab,
} from "../../core/skills/SkillController.ts";
import { theme } from "../theme/theme.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

interface Props {
	tabs: SkillPickerTab[];
	initialItem?: SkillPickerItem | null;
	onSelect: (
		item: SkillPickerItem,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function SkillsSelector({
	tabs,
	initialItem,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	const installedCount = installedSkillCount(tabs);
	const loadedCount = loadedSkillCount(tabs);
	return (
		<Picker
			title={`Skills (${installedCount} installed · ${loadedCount} loaded)`}
			subtitle="Select a skill to show options"
			tabs={orderSkillTabs(tabs).map(toPickerTab)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No skills in this source."
			initialItemId={initialItem ? pickerItemId(initialItem) : undefined}
		/>
	);
}

function pickerItemId(item: SkillPickerItem): string {
	return `${item.source}:${item.id}`;
}

function emptyLabelFor(id: SkillPickerTab["id"]): string {
	switch (id) {
		case "repo":
			return "No project skills. Create .agents/skills/<name>/SKILL.md";
		case "personal":
			return "No personal skills. Create ~/.agents/skills/<name>/SKILL.md";
		case "skills-sh":
			return "No remote skills found.";
	}
}

function toPickerTab(tab: SkillPickerTab): PickerTab<SkillPickerItem> {
	return {
		id: tab.id,
		label: tab.label,
		error: tab.error,
		emptyLabel: emptyLabelFor(tab.id),
		items: tab.items.map((item) => ({
			id: pickerItemId(item),
			name: item.name,
			nameColor: item.active ? theme.success : undefined,
			status:
				tab.id === "skills-sh"
					? undefined
					: item.active
						? "loaded"
						: "unloaded",
			statusColor: item.active ? theme.success : theme.subtle,
			badge: item.installs ?? "",
			description: item.description,
			detail: item.detail,
			value: item,
		})),
	};
}

export function installedSkillCount(tabs: readonly SkillPickerTab[]): number {
	const installed = new Set<string>();
	for (const tab of tabs) {
		if (tab.id === "skills-sh") continue;
		for (const item of tab.items) {
			installed.add(`${item.source}:${item.id}`);
		}
	}
	return installed.size;
}

export function loadedSkillCount(tabs: readonly SkillPickerTab[]): number {
	const loaded = new Set<string>();
	for (const tab of tabs) {
		if (tab.id === "skills-sh") continue;
		for (const item of tab.items) {
			if (item.active) loaded.add(item.name);
		}
	}
	return loaded.size;
}

export function orderSkillTabs(
	tabs: readonly SkillPickerTab[],
): SkillPickerTab[] {
	const remote = tabs.find((tab) => tab.id === "skills-sh");
	const installed = tabs.filter((tab) => tab.id !== "skills-sh");
	if (installedSkillCount(tabs) === 0 && remote) {
		return [remote, ...installed];
	}
	return remote ? [...installed, remote] : installed;
}
