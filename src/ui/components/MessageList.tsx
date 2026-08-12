import { Box, Text } from "ink";
import type React from "react";
import type {
	RenderTranscriptItem,
	TranscriptItem,
} from "../../state/AppState.ts";
import { theme } from "../theme/theme.ts";
import {
	AssistantMessage,
	AssistantMessageChunk,
	AssistantMessageFooter,
} from "./AssistantMessage.tsx";
import {
	InputSummary,
	TOOL_STATUS_ICON,
	ToolCallView,
	toolStatusColor,
} from "./ToolCallView.tsx";
import { ToolResultView } from "./ToolResultView.tsx";
import { UserMessage } from "./UserMessage.tsx";

interface Props {
	items: RenderTranscriptItem[];
}

type ToolTranscriptItem = Extract<TranscriptItem, { kind: "tool" }>;

// Tool grouping happens in the store when completed tools are drained into
// the static transcript (see state/toolGrouping.ts) - grouping here at render
// time would rewrite items already printed by <Static> and drop them.
export function MessageList({ items }: Props): React.ReactElement {
	return (
		<Box flexDirection="column">
			{items.map((item) => (
				<Item key={item.id} item={item} />
			))}
		</Box>
	);
}

export function Item({
	item,
}: {
	item: RenderTranscriptItem;
}): React.ReactElement {
	switch (item.kind) {
		case "user":
			return <UserMessage text={item.text} />;
		case "assistant":
			return <AssistantMessage text={item.text} durationMs={item.durationMs} />;
		case "assistant_chunk":
			return (
				<AssistantMessageChunk
					text={item.text}
					showHeader={item.showHeader}
					streaming={item.id.endsWith(":live")}
				/>
			);
		case "assistant_footer":
			return <AssistantMessageFooter durationMs={item.durationMs} />;
		case "tool":
			return (
				<ToolCallView
					name={item.name}
					inputSummary={item.inputSummary}
					status={item.status}
					agentMode={item.agentMode}
					childToolCalls={item.childToolCalls}
					title={item.title}
					detail={item.detail}
					detailLines={item.detailLines}
					error={item.error}
				/>
			);
		case "tool_group":
			return <ToolCallGroupView name={item.name} items={item.items} />;
		case "notice":
			return (
				<Box marginTop={1}>
					<Text color={noticeColor(item.level)}>{item.text}</Text>
				</Box>
			);
	}
}

function noticeColor(level: "info" | "warning" | "error"): string {
	if (level === "error") return theme.error;
	if (level === "warning") return theme.warning;
	return theme.accentBright;
}

function ToolCallGroupView({
	name,
	items,
}: {
	name: string;
	items: readonly ToolTranscriptItem[];
}): React.ReactElement {
	const status = items.some((item) => item.status === "error")
		? "error"
		: "done";
	return (
		<Box flexDirection="column" marginTop={1}>
			<Box>
				<Text color={toolStatusColor(status)}>{TOOL_STATUS_ICON[status]} </Text>
				<Text color={theme.accentBright} bold>
					{name}
				</Text>
				<Text color={theme.subtle}> ×{items.length}</Text>
			</Box>
			{items.map((item) => (
				<Box key={item.id} marginLeft={3} flexDirection="column">
					{item.inputSummary ? (
						<InputSummary summary={item.inputSummary} />
					) : null}
					<ToolResultView
						status={item.status}
						title={item.title}
						detail={item.detail}
						detailLines={item.detailLines}
						error={item.error}
					/>
				</Box>
			))}
		</Box>
	);
}
