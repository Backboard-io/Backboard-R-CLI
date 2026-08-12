import { Box, Text } from "ink";
import type React from "react";
import { clipEnd } from "../../utils/string.ts";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import { BackboardMascot } from "./BackboardMascot.tsx";
import type { SessionCardProps } from "./TerminalComponents.types.ts";

const DEFAULT_TERMINAL_COLUMNS = 80;
const SESSION_CARD_MAX_WIDTH = 74;
const SESSION_CARD_MIN_WIDTH = 24;
const MASCOT_BREAKPOINT = 48;
const MEDIUM_BREAKPOINT = 64;
const COMPACT_BREAKPOINT = 48;
const TIGHT_BREAKPOINT = 40;
const MASCOT_WIDTH = 15;

export interface SessionCardLayout {
	cardWidth: number;
	paddingX: number;
	rowLabelWidth: number;
	showMascot: boolean;
	showWorkspace: boolean;
	showSessionHeading: boolean;
	showModeRow: boolean;
	showContextRow: boolean;
	showHelpRow: boolean;
	showHelpDescription: boolean;
}

export function SessionCard({
	type = "authenticated",
	workspace = "backboard/studio",
	status = "Synced",
	model = "gpt-5.5 high fast",
	context = "0 / 1.0M",
	update = null,
}: SessionCardProps): React.ReactElement {
	const { columns } = useTerminalSize();
	const uiTheme = useTheme();
	const layout = sessionCardLayout(columns);
	const { contentWidth, headerTextWidth } = cardHeaderWidths(layout);
	const rowValueWidth = Math.max(1, contentWidth - layout.rowLabelWidth);

	if (type === "noAuth") {
		return (
			<Box
				borderStyle="round"
				borderColor={theme.accentBright}
				paddingX={1}
				width={layout.cardWidth}
			>
				<Text color={theme.warning} bold>
					{clipEnd("Backboard CLI needs authentication", contentWidth)}
				</Text>
				{layout.showHelpDescription ? (
					<Text color={theme.subtle}> · Run /login to continue</Text>
				) : null}
			</Box>
		);
	}

	return (
		<Box
			alignSelf="flex-start"
			borderStyle="round"
			borderColor={theme.accentBright}
			flexDirection="column"
			paddingX={layout.paddingX}
			paddingY={1}
			width={layout.cardWidth}
		>
			<CardHeader layout={layout}>
				{layout.showWorkspace ? (
					<Text color={uiTheme.readableSecondaryText}>
						{clipEnd(`Connected workspace: ${workspace}`, headerTextWidth)}
					</Text>
				) : null}
				<Text color={statusColor(status)}>Status: {status}</Text>
			</CardHeader>

			<Box flexDirection="column" marginTop={1}>
				{layout.showSessionHeading ? (
					<Text color={theme.text} bold>
						Current Session
					</Text>
				) : null}
				<Box flexDirection="column" marginTop={1}>
					{layout.showModeRow ? (
						<SessionRow
							label="mode"
							value="agent"
							labelWidth={layout.rowLabelWidth}
							valueWidth={rowValueWidth}
						/>
					) : null}
					<SessionRow
						label="model"
						value={model}
						labelWidth={layout.rowLabelWidth}
						valueWidth={rowValueWidth}
						accent
					/>
					{layout.showContextRow ? (
						<SessionRow
							label="context"
							value={context}
							labelWidth={layout.rowLabelWidth}
							valueWidth={rowValueWidth}
						/>
					) : null}
				</Box>
			</Box>

			{layout.showHelpRow ? (
				<Box marginTop={1}>
					<Box minWidth={layout.rowLabelWidth}>
						<Text color={theme.accentBright} bold>
							/help
						</Text>
					</Box>
					{layout.showHelpDescription ? (
						<Text color={uiTheme.readableSecondaryText}>View commands</Text>
					) : null}
				</Box>
			) : null}

			{update && layout.showHelpRow ? (
				<Box>
					<Box minWidth={layout.rowLabelWidth}>
						<Text color={theme.warning} bold>
							/update
						</Text>
					</Box>
					<Text color={theme.warning}>
						{clipEnd(
							layout.showHelpDescription
								? `New version v${update.latest} available (on v${update.current})`
								: `v${update.latest} available`,
							rowValueWidth,
						)}
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

/**
 * The shared card header row: the mascot (when the layout shows it) beside the
 * bold "Backboard CLI is ready" title, with caller-provided lines below the
 * title. Callers clip their own lines to `cardHeaderWidths(layout)`.
 */
export function CardHeader({
	layout,
	children,
}: {
	layout: SessionCardLayout;
	children: React.ReactNode;
}): React.ReactElement {
	const { headerTextWidth } = cardHeaderWidths(layout);
	return (
		<Box>
			{layout.showMascot ? (
				<Box
					flexDirection="column"
					justifyContent="center"
					marginRight={2}
					minWidth={13}
				>
					<BackboardMascot />
				</Box>
			) : null}
			<Box flexDirection="column" justifyContent="center">
				<Text color={theme.text} bold>
					{clipEnd("Backboard CLI is ready", headerTextWidth)}
				</Text>
				{children}
			</Box>
		</Box>
	);
}

export function sessionCardLayout(columns: number): SessionCardLayout {
	const terminalColumns =
		Number.isFinite(columns) && columns > 0
			? Math.floor(columns)
			: DEFAULT_TERMINAL_COLUMNS;
	const cardWidth = Math.max(
		SESSION_CARD_MIN_WIDTH,
		Math.min(SESSION_CARD_MAX_WIDTH, terminalColumns - 6),
	);

	return {
		cardWidth,
		paddingX: terminalColumns < TIGHT_BREAKPOINT ? 1 : 2,
		rowLabelWidth: terminalColumns < COMPACT_BREAKPOINT ? 8 : 13,
		showMascot: terminalColumns >= MASCOT_BREAKPOINT,
		showWorkspace: terminalColumns >= MEDIUM_BREAKPOINT,
		showSessionHeading: terminalColumns >= COMPACT_BREAKPOINT,
		showModeRow: terminalColumns >= TIGHT_BREAKPOINT,
		showContextRow: terminalColumns >= TIGHT_BREAKPOINT,
		showHelpRow: terminalColumns >= TIGHT_BREAKPOINT,
		showHelpDescription: terminalColumns >= COMPACT_BREAKPOINT,
	};
}

// The round border occupies one column on each side of the card.
const CARD_BORDER_COLUMNS = 2;

// NOTE: unlike the pre-existing SessionCard math, this subtracts the border
// columns — Ink renders the border inside width={cardWidth}. Intentional fix:
// all cards now clip 2 columns earlier than before.
export function cardHeaderWidths(layout: SessionCardLayout): {
	contentWidth: number;
	headerTextWidth: number;
} {
	const contentWidth = Math.max(
		1,
		layout.cardWidth - CARD_BORDER_COLUMNS - layout.paddingX * 2,
	);
	const headerTextWidth = layout.showMascot
		? Math.max(1, contentWidth - MASCOT_WIDTH)
		: contentWidth;
	return { contentWidth, headerTextWidth };
}

function statusColor(status: string): string {
	if (status === "Thinking") return theme.warning;
	if (status === "Cancelled") return theme.error;
	return theme.success;
}

function SessionRow({
	label,
	value,
	labelWidth,
	valueWidth,
	accent,
}: {
	label: string;
	value: string;
	labelWidth: number;
	valueWidth: number;
	accent?: boolean;
}): React.ReactElement {
	const uiTheme = useTheme();
	return (
		<Box>
			<Box minWidth={labelWidth}>
				<Text color={uiTheme.readableSecondaryText}>{label}</Text>
			</Box>
			<Text color={accent ? theme.accentBright : theme.text}>
				{clipEnd(value, valueWidth)}
			</Text>
		</Box>
	);
}
