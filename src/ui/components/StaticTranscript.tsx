import { Static } from "ink";
import type React from "react";
import { memo } from "react";
import type { UsageInfo } from "../../core/bus/events.ts";
import type { StartupUpdateInfo } from "../../core/update/startupNotice.ts";
import type { RenderTranscriptItem, RunStatus } from "../../state/AppState.ts";
import { Banner } from "./Banner.tsx";
import { Item } from "./MessageList.tsx";

interface Props {
	items: RenderTranscriptItem[];
	generation: number;
	banner: {
		status: RunStatus;
		model: string;
		cwd: string;
		usage: UsageInfo;
		update?: StartupUpdateInfo | null;
	} | null;
}

type StaticTranscriptItem =
	| RenderTranscriptItem
	| {
			kind: "banner";
			id: string;
			status: RunStatus;
			model: string;
			cwd: string;
			usage: UsageInfo;
			update?: StartupUpdateInfo | null;
	  };

function StaticTranscriptComponent({
	items,
	generation,
	banner,
}: Props): React.ReactElement {
	// Items arrive pre-grouped from the store; do NOT regroup here - <Static>
	// is append-only and rewriting already-printed entries drops them.
	const staticItems: StaticTranscriptItem[] = banner
		? [
				{
					kind: "banner",
					id: "banner",
					status: banner.status,
					model: banner.model,
					cwd: banner.cwd,
					usage: banner.usage,
					update: banner.update,
				},
				...items,
			]
		: items;

	return (
		<Static key={generation} items={staticItems}>
			{(item) =>
				item.kind === "banner" ? (
					<Banner
						key={item.id}
						status={item.status}
						model={item.model}
						cwd={item.cwd}
						usage={item.usage}
						update={item.update}
					/>
				) : (
					<Item key={item.id} item={item} />
				)
			}
		</Static>
	);
}

export function shouldReuseStaticTranscript(
	previous: Props,
	next: Props,
): boolean {
	if (previous.generation !== next.generation) return false;
	if (previous.items.length !== next.items.length) return false;
	// <Static> is append-only. Banner changes are picked up when generation
	// changes and the transcript is intentionally reprinted. During ordinary
	// App updates, avoid touching Ink's internal_static node because that
	// bypasses maxFps and forces an immediate render.
	return previous.items.every((item, index) => item === next.items[index]);
}

export const StaticTranscript = memo(
	StaticTranscriptComponent,
	shouldReuseStaticTranscript,
);
