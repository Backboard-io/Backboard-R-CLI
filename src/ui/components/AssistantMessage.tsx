import { Box, Text } from "ink";
import type React from "react";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { theme } from "../theme/theme.ts";
import type { AssistantMessageProps } from "./AssistantMessage.types.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import {
	ASSISTANT_OUTPUT_MARKER,
	ASSISTANT_SEPARATOR_MIN_WIDTH,
} from "./MessageLayout.constants.ts";
import { formatElapsedDuration } from "./SpinnerFormatting.ts";

export function AssistantMessage({
	text,
	durationMs,
}: AssistantMessageProps): React.ReactElement {
	return (
		<>
			<AssistantMessageChunk text={text} showHeader />
			{durationMs === undefined ? null : (
				<AssistantMessageFooter durationMs={durationMs} />
			)}
		</>
	);
}

export function AssistantMessageChunk({
	text,
	showHeader,
	streaming = false,
}: {
	text: string;
	showHeader: boolean;
	streaming?: boolean;
}): React.ReactElement {
	const { columns } = useTerminalSize();
	const width = terminalWidth(columns);
	const contentWidth = Math.max(1, width - ASSISTANT_OUTPUT_MARKER.length - 2);
	const blankOnly = !streaming && text.trim().length === 0;
	const paragraphBreak =
		!streaming && !blankOnly && /\n[^\S\n]*\n\s*$/.test(text);

	return (
		<Box marginTop={showHeader ? 1 : 0} flexDirection="column" width="100%">
			<Box marginBottom={paragraphBreak ? 1 : 0} flexDirection="row">
				<Text color={theme.subtle}>
					{showHeader
						? ASSISTANT_OUTPUT_MARKER
						: " ".repeat(ASSISTANT_OUTPUT_MARKER.length)}
				</Text>
				<Box marginLeft={1} width={contentWidth} flexShrink={0}>
					{streaming ? (
						<Text color={theme.text} wrap="wrap">
							{text}
						</Text>
					) : blankOnly ? (
						<Text> </Text>
					) : (
						<MarkdownText text={text} />
					)}
				</Box>
			</Box>
		</Box>
	);
}

export function AssistantMessageFooter({
	durationMs,
}: {
	durationMs: number;
}): React.ReactElement | null {
	const label = assistantWorkedLabel(durationMs);
	if (label === null) return null;
	return (
		<Box marginTop={1}>
			<Text color={theme.subtle}>{label}</Text>
		</Box>
	);
}

export function assistantWorkedLabel(durationMs: number): string | null {
	if (durationMs < 60_000) return null;
	return `Worked for ${formatElapsedDuration(durationMs)}`;
}

function terminalWidth(columns: number): number {
	return Math.max(
		ASSISTANT_SEPARATOR_MIN_WIDTH,
		typeof columns === "number" && columns > 0 ? columns : 80,
	);
}
