import { Box } from "ink";
import type React from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import type {
	PromptSurfaceProps,
	PromptSurfaceState,
} from "./PromptSurface.types.ts";

export function PromptSurface({
	children,
	state = "idle",
}: PromptSurfaceProps): React.ReactElement {
	const uiTheme = useTheme();
	// Background-filled rail column (not a "▌" glyph) so it's gapless everywhere.
	return (
		<Box width="100%" minHeight={3} flexDirection="row">
			<Box
				flexShrink={0}
				width={1}
				backgroundColor={promptSurfaceRailColor(state)}
			/>
			<Box
				flexGrow={1}
				flexShrink={1}
				flexDirection="column"
				paddingX={1}
				paddingY={1}
				backgroundColor={uiTheme.inputSurfaceBackground}
			>
				{children}
			</Box>
		</Box>
	);
}

function promptSurfaceRailColor(state: PromptSurfaceState): string {
	switch (state) {
		case "submitted":
			return theme.subtleDecoration;
		case "active":
		case "idle":
			return theme.accentBright;
	}
}
