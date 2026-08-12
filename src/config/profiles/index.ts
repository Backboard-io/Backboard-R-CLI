import { codingProfile, type Profile } from "./coding.ts";

const PROFILES: Record<string, Profile> = {
	coding: codingProfile,
};

export function getProfile(name: string): Profile {
	const profile = PROFILES[name];
	if (!profile) {
		throw new Error(`Unknown profile: ${name}`);
	}
	return profile;
}

export function listProfiles(): Profile[] {
	return Object.values(PROFILES);
}

export type { Profile };
