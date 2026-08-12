import { Box, Text, useInput } from "ink";
import type React from "react";
import { formatModel } from "../../config/defaults.ts";
import type { ContextReport } from "../../core/context/index.ts";
import { formatTokens } from "../../core/context/index.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

interface Props {
	report: ContextReport;
	onClose: () => void;
}

const BAR_WIDTH = 32;
const LABEL_WIDTH = 18;

/** Colour tracks urgency: green, then amber approaching compression, red past it. */
function fillColor(percent: number, threshold: number): string {
	if (percent >= threshold) return theme.error;
	if (percent >= threshold * 0.75) return theme.warning;
	return theme.success;
}

function bar(
	percent: number,
	width: number,
): { filled: number; empty: number } {
	const filled = Math.max(
		0,
		Math.min(width, Math.round((percent / 100) * width)),
	);
	return { filled, empty: width - filled };
}

export function ContextPanel({ report, onClose }: Props): React.ReactElement {
	const uiTheme = useTheme();
	const { columns } = useTerminalSize();
	useInput(() => onClose());

	const width = Math.max(1, Math.min(columns - 4, 92));
	const contentWidth = Math.max(1, width - 4);
	const narrow = width < 58;
	const usageBarWidth = Math.max(1, Math.min(BAR_WIDTH, contentWidth));
	const segmentBarWidth = Math.max(
		1,
		Math.min(16, narrow ? contentWidth - 2 : 16),
	);
	const color = fillColor(report.percent, report.compactThresholdPercent);
	const { filled, empty } = bar(report.percent, usageBarWidth);

	// Segments are scaled against the estimated total, not the measured one, so
	// the sub-bars stay proportional to each other even when the two disagree.
	const scale = Math.max(report.estimatedTotal, 1);
	const segments = [...report.segments]
		.filter((segment) => segment.tokens > 0)
		.sort((left, right) => right.tokens - left.tokens);

	return (
		<Box
			flexDirection="column"
			marginTop={1}
			paddingX={2}
			paddingY={1}
			width={width}
			backgroundColor={uiTheme.inputSurfaceBackground}
		>
			<Box flexDirection={narrow ? "column" : "row"}>
				<Text color={theme.text} bold>
					Context
				</Text>
				<Text color={theme.subtle} wrap="truncate-end">
					{narrow ? "" : "  "}
					{formatModel(report.model)}
					{report.source === "byok" ? " · your key" : " · Backboard"}
				</Text>
			</Box>

			<Box marginTop={1} flexDirection={narrow ? "column" : "row"}>
				<Box>
					<Text color={color}>{"█".repeat(filled)}</Text>
					<Text color={theme.subtleDecoration}>{"░".repeat(empty)}</Text>
				</Box>
				<Box>
					<Text color={color} bold>
						{narrow ? "" : "  "}
						{report.percent.toFixed(0)}%
					</Text>
					<Text color={theme.subtle}>
						{"  "}
						{formatTokens(report.usedTokens)} / {formatTokens(report.limit)}
					</Text>
				</Box>
			</Box>
			{!report.measured ? (
				<Text color={theme.subtle}>
					Estimated — no turn has reported usage yet.
				</Text>
			) : null}

			<Box marginTop={1}>
				<Text color={theme.subtle}>Breakdown (estimated)</Text>
			</Box>
			{segments.map((segment) => {
				const share = (segment.tokens / scale) * 100;
				const sub = bar(share, segmentBarWidth);
				return (
					<Box key={segment.label} flexDirection={narrow ? "column" : "row"}>
						<Text color={theme.text}>
							{narrow ? segment.label : segment.label.padEnd(LABEL_WIDTH)}
						</Text>
						{narrow ? (
							<>
								<Box>
									<Text color={theme.accentBright}>
										{"▰".repeat(sub.filled)}
									</Text>
									<Text color={theme.subtleDecoration}>
										{"▱".repeat(sub.empty)}
									</Text>
								</Box>
								<Text color={theme.subtle}>
									~{formatTokens(segment.tokens)}
									{segment.detail ? ` · ${segment.detail}` : ""}
								</Text>
							</>
						) : (
							<Box>
								<Text color={theme.accentBright}>{"▰".repeat(sub.filled)}</Text>
								<Text color={theme.subtleDecoration}>
									{"▱".repeat(sub.empty)}
								</Text>
								<Text color={theme.subtle}>
									{"  ~"}
									{formatTokens(segment.tokens).padEnd(7)}
									{segment.detail ? ` ${segment.detail}` : ""}
								</Text>
							</Box>
						)}
					</Box>
				);
			})}

			<Box marginTop={1} flexDirection="column">
				{report.cachedTokens > 0 ? (
					<Text color={theme.subtle}>
						Prompt cache: {formatTokens(report.cachedTokens)} of the last
						request served from cache ({report.cachedPercent.toFixed(0)}%)
					</Text>
				) : (
					<Text color={theme.subtle}>
						Prompt cache: no cached tokens on the last request
					</Text>
				)}
				<Text color={theme.subtle}>
					{report.percent >= report.compactThresholdPercent
						? `Over the ${report.compactThresholdPercent}% threshold — compressing after the next turn.`
						: `Auto-compress at ${report.compactThresholdPercent}% (${formatTokens(report.compactAtTokens)}) · /compress to do it now`}
				</Text>
			</Box>

			<Box marginTop={1}>
				<Text color={theme.subtle}>Press any key to close</Text>
			</Box>
		</Box>
	);
}
