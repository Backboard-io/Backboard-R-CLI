import type { RenderTranscriptItem } from "../../state/AppState.ts";
import { pluralize } from "../../utils/string.ts";
import {
	LIVE_TRANSCRIPT_TAIL_ITEMS,
	RESPONSIVE_TRANSCRIPT_TAIL_ITEMS,
} from "./TranscriptLayout.constants.ts";
import type { TranscriptLayout } from "./TranscriptLayout.types.ts";

export function splitResponsiveTranscript(
	items: RenderTranscriptItem[],
	tailItemCount = RESPONSIVE_TRANSCRIPT_TAIL_ITEMS,
	minimumStaticItemCount = 0,
): TranscriptLayout {
	const desiredSplitIndex = Math.max(0, items.length - tailItemCount);
	const splitIndex = Math.min(
		items.length,
		Math.max(desiredSplitIndex, minimumStaticItemCount),
	);
	return {
		staticItems: items.slice(0, splitIndex),
		responsiveItems: items.slice(splitIndex),
	};
}

export function compactLiveTranscriptItems(
	items: RenderTranscriptItem[],
	tailItemCount = LIVE_TRANSCRIPT_TAIL_ITEMS,
): RenderTranscriptItem[] {
	if (items.length <= tailItemCount) return items;
	const tailStart = Math.max(0, items.length - tailItemCount);
	const visibleItems = items.filter(
		(item, index) =>
			index >= tailStart || (item.kind === "tool" && item.status === "running"),
	);
	const hiddenCount = items.length - visibleItems.length;
	if (hiddenCount === 0) return items;
	return [
		{
			kind: "notice",
			id: "live-items-hidden",
			level: "info",
			text: `${hiddenCount} earlier live ${pluralize(hiddenCount, "item")} hidden while this turn is running.`,
		},
		...visibleItems,
	];
}
