import type { RenderTranscriptItem, TranscriptItem } from "./AppState.ts";

type ToolTranscriptItem = Extract<TranscriptItem, { kind: "tool" }>;

/**
 * Collapses completed calls to the same tool within one drained batch into a
 * single "tool_group" item. Applies to every tool and every finished status
 * (done or error); only still-running calls and subagent calls (which have
 * their own rich view) are left standalone. Same-name calls group even when
 * another tool sits between them, but never across non-tool items.
 *
 * Must only be applied to items BEFORE they are committed to the append-only
 * static transcript (Ink's <Static> never re-renders already-printed entries,
 * so retroactive grouping would drop items).
 */
export function groupConsecutiveToolItems(
	items: readonly RenderTranscriptItem[],
): RenderTranscriptItem[] {
	const grouped: RenderTranscriptItem[] = [];
	let groupSlotByName = new Map<string, number>();
	for (const item of items) {
		if (item.kind !== "tool") {
			groupSlotByName = new Map();
			grouped.push(item);
			continue;
		}
		if (!isGroupableToolItem(item)) {
			grouped.push(item);
			continue;
		}
		const slot = groupSlotByName.get(item.name);
		const previous = slot === undefined ? undefined : grouped[slot];
		if (previous?.kind === "tool_group") {
			previous.items = [...previous.items, item];
			continue;
		}
		if (previous?.kind === "tool" && isGroupableToolItem(previous)) {
			grouped[slot as number] = {
				kind: "tool_group",
				id: `${previous.id}:group`,
				name: previous.name,
				items: [previous, item],
			};
			continue;
		}
		groupSlotByName.set(item.name, grouped.length);
		grouped.push(item);
	}
	return grouped;
}

function isGroupableToolItem(
	item: RenderTranscriptItem,
): item is ToolTranscriptItem {
	return (
		item.kind === "tool" &&
		(item.status === "done" || item.status === "error") &&
		item.agentMode === undefined &&
		(item.childToolCalls?.length ?? 0) === 0
	);
}
