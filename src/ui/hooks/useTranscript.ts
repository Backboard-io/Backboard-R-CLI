import type { AppState, TranscriptItem } from "../../state/AppState.ts";

/** Selector for the transcript items. Kept as a hook for future windowing. */
export function useTranscript(state: AppState): TranscriptItem[] {
	return state.transcript;
}
