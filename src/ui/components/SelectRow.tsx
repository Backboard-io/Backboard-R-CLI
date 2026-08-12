import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import {
	SELECT_CARET_PLACEHOLDER,
	SELECT_CARET_PREFIX,
} from "./Glyphs.constants.ts";

/** The standard selection caret column: `› ` when selected, blank otherwise. */
export function SelectCaret({
	selected,
	color,
}: {
	selected: boolean;
	color?: string;
}): React.ReactElement {
	return (
		<Text color={color ?? (selected ? theme.accentBright : theme.subtle)}>
			{selected ? SELECT_CARET_PREFIX : SELECT_CARET_PLACEHOLDER}
		</Text>
	);
}

/**
 * A selectable list row: caret column plus caller-rendered body. Numbering,
 * status dots, and column layout stay with the caller — only the caret and
 * row container are shared.
 */
export function SelectRow({
	selected,
	children,
}: {
	selected: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Box>
			<SelectCaret selected={selected} />
			{children}
		</Box>
	);
}
