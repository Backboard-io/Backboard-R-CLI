import type { Skill } from "./Skill.ts";
import type { SkillPickerTab } from "./SkillPickerTypes.ts";

export const SKILL_PICKER_CACHE_TTL_MS = 60_000;

export interface SkillPickerState {
	tabs: SkillPickerTab[];
	pickerSkills: Map<string, Skill>;
	warnings: string[];
	expiresAt: number;
}

export class SkillPickerCache {
	private state: SkillPickerState | undefined;
	private pending: Promise<SkillPickerState> | undefined;

	get(): SkillPickerState | undefined {
		return this.state;
	}

	isStale(state: SkillPickerState, now = Date.now()): boolean {
		return state.expiresAt <= now;
	}

	refresh(load: () => Promise<SkillPickerState>): Promise<SkillPickerState> {
		if (this.pending) return this.pending;
		const pending = load()
			.then((state) => {
				if (this.pending === pending) this.state = state;
				return state;
			})
			.finally(() => {
				if (this.pending === pending) this.pending = undefined;
			});
		this.pending = pending;
		return pending;
	}

	/** Drop cached state so the next read reloads from disk. */
	invalidate(): void {
		this.state = undefined;
		this.pending = undefined;
	}
}

export function cloneSkillPickerTabs(
	tabs: readonly SkillPickerTab[],
): SkillPickerTab[] {
	return tabs.map((tab) => ({
		...tab,
		items: tab.items.map((item) => ({ ...item })),
	}));
}
