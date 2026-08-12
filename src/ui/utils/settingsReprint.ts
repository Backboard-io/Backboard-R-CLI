export interface SettingsExitTransition {
	previousMode: string;
	mode: string;
	memoryReturnsToSettings: boolean;
	verboseAtOpen: boolean;
	verboseNow: boolean;
}

/**
 * Decides whether a mode transition out of the settings panel must clear the
 * screen and reprint the transcript at the new verbosity. Evaluated on every
 * mode change so no exit path can skip it: the hop into the memory selector
 * (and back) is not an exit, and a net-zero verbose toggle needs no reprint
 * because `verboseAtOpen` is captured once when the panel opens.
 */
export function shouldReprintOnSettingsExit(
	transition: SettingsExitTransition,
): boolean {
	if (transition.previousMode !== "settings") return false;
	if (transition.mode === "settings") return false;
	if (transition.mode === "memory" && transition.memoryReturnsToSettings) {
		return false;
	}
	return transition.verboseNow !== transition.verboseAtOpen;
}
