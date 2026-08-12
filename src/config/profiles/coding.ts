import {
	DEFAULTS,
	type MemoryMode,
	type MemoryProfile,
	type ModelRef,
} from "../defaults.ts";

export interface Profile {
	name: string;
	memory: MemoryMode;
	memoryProfile: MemoryProfile;
	model: ModelRef;
	/** Tool names enabled for this profile. Empty array means "all registered". */
	tools: string[];
}

export const codingProfile: Profile = {
	name: "coding",
	memory: DEFAULTS.memory,
	memoryProfile: "code",
	model: DEFAULTS.model,
	tools: [],
};
