import { Box, Text } from "ink";
import type React from "react";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";

/**
 * The shared modal-panel shell: full-width surface with the standard margin
 * and padding, on the input surface background. `title` renders as the bold
 * heading line; panels with richer headers pass them as children instead.
 */
export function Panel({
	title,
	children,
}: {
	title?: string;
	children: React.ReactNode;
}): React.ReactElement {
	const uiTheme = useTheme();
	return (
		<Box flexDirection="column">
			<Box
				flexDirection="column"
				marginTop={1}
				paddingX={2}
				paddingY={1}
				width="100%"
				backgroundColor={uiTheme.inputSurfaceBackground}
			>
				{title ? (
					<Box marginBottom={1}>
						<Text color={theme.text} bold>
							{title}
						</Text>
					</Box>
				) : null}
				{children}
			</Box>
		</Box>
	);
}
