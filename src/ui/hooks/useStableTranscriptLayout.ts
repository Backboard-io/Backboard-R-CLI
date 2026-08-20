import { useMemo, useRef } from "react";
import type { RenderTranscriptItem } from "../../state/AppState.ts";
import type { StaticTranscriptBanner } from "../components/StaticTranscript.tsx";
import { responsiveTranscriptSplitIndex } from "../components/TranscriptLayout.ts";
import type { TranscriptLayout } from "../components/TranscriptLayout.types.ts";

export function useStableTranscriptLayout(
	items: RenderTranscriptItem[],
	tailItemCount?: number,
	generation?: number,
): TranscriptLayout {
	const staticItemCount = useRef(0);
	const generationRef = useRef(generation);
	if (generationRef.current !== generation) {
		generationRef.current = generation;
		staticItemCount.current = 0;
	}
	const minimumStaticItemCount = Math.min(
		staticItemCount.current,
		items.length,
	);
	const splitIndex = responsiveTranscriptSplitIndex(
		items.length,
		tailItemCount,
		minimumStaticItemCount,
	);
	const layout = useMemo(
		() => ({
			staticItems: items.slice(0, splitIndex),
			responsiveItems: items.slice(splitIndex),
		}),
		[items, splitIndex],
	);
	staticItemCount.current = layout.staticItems.length;
	return layout;
}

export function useStableStaticBanner(
	banner: StaticTranscriptBanner | null,
	generation: number,
): StaticTranscriptBanner | null {
	const snapshot = useRef({
		banner,
		generation,
		hasBanner: banner !== null,
	});
	const hasBanner = banner !== null;
	if (
		snapshot.current.generation !== generation ||
		snapshot.current.hasBanner !== hasBanner
	) {
		snapshot.current = { banner, generation, hasBanner };
	}
	return snapshot.current.banner;
}
