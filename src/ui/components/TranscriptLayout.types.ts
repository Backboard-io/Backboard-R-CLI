import type { RenderTranscriptItem } from "../../state/AppState.ts";

export interface TranscriptLayout {
	staticItems: RenderTranscriptItem[];
	responsiveItems: RenderTranscriptItem[];
}
