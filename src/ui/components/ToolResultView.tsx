import { Box, Text } from "ink";
import type React from "react";
import type { ToolResultDetailLine } from "../../core/tools/ToolResultDetail.ts";
import { expandTabs, padColumn } from "../../utils/string.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useVerbose } from "../hooks/VerboseContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { withStableKeys } from "../utils/stableKeys.ts";

const RESULT_PREFIX = "  └ ";
const RESULT_DETAIL_INDENT = RESULT_PREFIX.length;
const DIFF_DETAIL_MAX_WIDTH = 96;
const DIFF_DETAIL_TERMINAL_PADDING = 14;

interface Props {
	status: "pending" | "running" | "done" | "error";
	title?: string;
	detail?: string;
	detailLines?: ToolResultDetailLine[];
	error?: string;
}

export function ToolResultView({
	status,
	title,
	detail,
	detailLines,
	error,
}: Props): React.ReactElement | null {
	const uiTheme = useTheme();
	const verbose = useVerbose();
	const { columns } = useTerminalSize();
	// The free-form output preview is the "verbose" content; structured diff
	// lines (detailLines) stay visible either way since they are compact edit
	// feedback, not chatty output.
	const plainDetailLines =
		detail && verbose ? withStableKeys(detail.split("\n"), (line) => line) : [];
	const diffWidth = diffDetailBlockWidth(columns);
	if (status === "error") {
		return (
			<Text color={theme.toolError}>
				{RESULT_PREFIX}
				{error ?? "failed"}
			</Text>
		);
	}
	if (
		status === "done" &&
		(title || plainDetailLines.length || detailLines?.length)
	) {
		return (
			<Box flexDirection="column">
				{title ? (
					<Text color={theme.subtle}>
						{RESULT_PREFIX}
						{title}
					</Text>
				) : null}
				{detailLines?.length ? (
					<Box
						marginLeft={RESULT_DETAIL_INDENT}
						flexDirection="column"
						alignSelf="stretch"
						width={diffWidth}
					>
						{detailLines.map((line) => {
							const backgroundColor =
								line.kind === "added"
									? uiTheme.diffAddedBackground
									: line.kind === "removed"
										? uiTheme.diffRemovedBackground
										: line.highlighted
											? uiTheme.highlightBackground
											: undefined;
							const color = backgroundColor ? theme.text : theme.subtle;
							return (
								<Box
									key={line.key}
									backgroundColor={backgroundColor}
									alignSelf="stretch"
									width={diffWidth}
								>
									<Text color={color}>
										{fitDetailLine(line.displayValue, diffWidth)}
									</Text>
								</Box>
							);
						})}
					</Box>
				) : null}
				{plainDetailLines.length > 0 ? (
					<Box
						marginLeft={RESULT_DETAIL_INDENT}
						flexDirection="column"
						width={diffWidth}
					>
						{plainDetailLines.map((line) => (
							<Text key={line.key} color={theme.subtle} wrap="truncate-end">
								{line.item}
							</Text>
						))}
					</Box>
				) : null}
			</Box>
		);
	}
	return null;
}

export function diffDetailBlockWidth(columns: number): number {
	const terminalColumns =
		Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
	const available = Math.max(
		24,
		terminalColumns - DIFF_DETAIL_TERMINAL_PADDING,
	);
	return Math.min(DIFF_DETAIL_MAX_WIDTH, available);
}

function fitDetailLine(value: string, width: number): string {
	return padColumn(expandTabs(value), width);
}
