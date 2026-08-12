export type SystemPromptFragmentId = "core";

export interface SystemPromptLayout {
	header?: SystemPromptFragmentId;
	base: SystemPromptFragmentId;
	footer?: SystemPromptFragmentId;
}

export interface ModelProfile {
	name: string;
	/** Lowercase substrings matched against provider/model. Empty means fallback only. */
	matchers: string[];
	/** Tool names enabled for this model profile. Empty array means all registered. */
	tools: string[];
	/** Tool names hidden for this model profile. */
	excludedTools?: string[];
	systemPromptLayout: SystemPromptLayout;
}
