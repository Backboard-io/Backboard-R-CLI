import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { DOT_SEPARATOR } from "./Glyphs.constants.ts";

/**
 * Joins keyboard hints into the standard footer line, dropping falsy entries
 * so callers can include hints conditionally:
 * `hintFooterText(["↑/↓ choose", hasTabs && "←/→ tabs", "Esc cancel"])`.
 */
export function hintFooterText(
	hints: readonly (string | false | null | undefined)[],
): string {
	return hints.filter(Boolean).join(DOT_SEPARATOR);
}

/** The standard subtle keyboard-hint footer row shown below panels. */
export function HintFooter({
	hints,
	marginTop = 1,
}: {
	hints: readonly (string | false | null | undefined)[];
	marginTop?: number;
}): React.ReactElement {
	return (
		<Box marginTop={marginTop}>
			<Text color={theme.subtle}>{hintFooterText(hints)}</Text>
		</Box>
	);
}
