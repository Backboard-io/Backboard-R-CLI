import { Box, Text } from "ink";
import type React from "react";
import { useTerminalSize } from "../hooks/TerminalSizeContext.tsx";
import { theme } from "../theme/theme.ts";
import { compactPathLabel } from "../utils/pathLabels.ts";
import { SHELL_PROMPT_GLYPH } from "./Glyphs.constants.ts";
import {
	DEFAULT_SHELL_SEGMENTS,
	SHELL_PROMPT_CHILD_GAP,
	SHELL_PROMPT_DEFAULT_COLUMNS,
	SHELL_PROMPT_DIVIDER_WIDTH,
	SHELL_PROMPT_MIN_PATH_WIDTH,
	SHELL_PROMPT_OUTER_PADDING,
	SHELL_PROMPT_SEGMENT_PADDING_WIDTH,
} from "./TerminalComponents.constants.ts";
import type {
	ShellPromptLayout,
	ShellPromptLayoutInput,
	ShellPromptProps,
} from "./TerminalComponents.types.ts";

export function ShellPrompt({
	state = "default",
	user = DEFAULT_SHELL_SEGMENTS.user,
	path = DEFAULT_SHELL_SEGMENTS.path,
	version = DEFAULT_SHELL_SEGMENTS.version,
	time,
}: ShellPromptProps): React.ReactElement {
	const active = state === "active";
	const { columns } = useTerminalSize();
	const layout = shellPromptLayout({ columns, user, path, version, time });
	return (
		<Box gap={1}>
			{layout.user ? (
				<>
					<ShellSegment
						label={layout.user}
						backgroundColor={active ? theme.success : undefined}
					/>
					<ShellDivider />
				</>
			) : null}
			<ShellSegment
				label={layout.path}
				backgroundColor={active ? theme.accentBright : undefined}
			/>
			{layout.version ? (
				<>
					<ShellDivider />
					<ShellSegment
						label={layout.version}
						backgroundColor={active ? theme.warning : undefined}
					/>
				</>
			) : null}
			{layout.time ? (
				<>
					<ShellDivider />
					<ShellSegment
						label={layout.time}
						backgroundColor={active ? theme.subtleDecoration : undefined}
					/>
				</>
			) : null}
		</Box>
	);
}

export function shellPromptLayout(
	input: ShellPromptLayoutInput,
): ShellPromptLayout {
	const columns =
		Number.isFinite(input.columns) && input.columns > 0
			? Math.floor(input.columns)
			: SHELL_PROMPT_DEFAULT_COLUMNS;
	const availableWidth = Math.max(1, columns - SHELL_PROMPT_OUTER_PADDING);
	const candidates: ShellPromptLayout[] = [
		{
			user: input.user,
			path: input.path,
			version: input.version,
			...(input.time ? { time: input.time } : {}),
		},
		{
			user: input.user,
			path: input.path,
			version: input.version,
		},
		{
			path: input.path,
			version: input.version,
		},
		{
			path: input.path,
		},
	];

	for (const candidate of candidates) {
		const fitted = fitShellPromptPath(candidate, availableWidth);
		if (shellPromptWidth(fitted) <= availableWidth) return fitted;
	}

	return {
		path: compactPathLabel(input.path, availableWidth),
	};
}

function fitShellPromptPath(
	layout: ShellPromptLayout,
	availableWidth: number,
): ShellPromptLayout {
	let pathWidth = layout.path.length;
	while (pathWidth >= SHELL_PROMPT_MIN_PATH_WIDTH) {
		const candidate = {
			...layout,
			path: compactPathLabel(layout.path, pathWidth),
		};
		if (shellPromptWidth(candidate) <= availableWidth) return candidate;
		pathWidth -= 1;
	}
	return {
		...layout,
		path: compactPathLabel(layout.path, SHELL_PROMPT_MIN_PATH_WIDTH),
	};
}

function shellPromptWidth(layout: ShellPromptLayout): number {
	const labels = [layout.user, layout.path, layout.version, layout.time].filter(
		(label): label is string => typeof label === "string" && label.length > 0,
	);
	if (labels.length === 0) return 0;
	const segmentWidth = labels.reduce(
		(total, label) => total + label.length + SHELL_PROMPT_SEGMENT_PADDING_WIDTH,
		0,
	);
	const dividerWidth = (labels.length - 1) * SHELL_PROMPT_DIVIDER_WIDTH;
	const childCount = labels.length * 2 - 1;
	const gapWidth = (childCount - 1) * SHELL_PROMPT_CHILD_GAP;
	return segmentWidth + dividerWidth + gapWidth;
}

function ShellSegment({
	label,
	backgroundColor,
}: {
	label: string;
	backgroundColor?: string;
}): React.ReactElement {
	return (
		<Box paddingX={1}>
			<Text
				backgroundColor={backgroundColor}
				color={backgroundColor ? theme.inputBackground : theme.text}
				bold
			>
				{label}
			</Text>
		</Box>
	);
}

function ShellDivider(): React.ReactElement {
	return (
		<Text color={theme.subtle} bold>
			{SHELL_PROMPT_GLYPH}
		</Text>
	);
}
