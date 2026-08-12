import { Box, Text } from "ink";
import type React from "react";
import { theme } from "../theme/theme.ts";
import { PromptSurface } from "./PromptSurface.tsx";

interface Props {
	text: string;
}

export function UserMessage({ text }: Props): React.ReactElement {
	return (
		<Box marginTop={1} width="100%">
			<PromptSurface state="submitted">
				<Box flexDirection="row" width="100%">
					<Box flexGrow={1} flexShrink={1}>
						<Text color={theme.inputText} wrap="wrap">
							{text}
						</Text>
					</Box>
				</Box>
			</PromptSurface>
		</Box>
	);
}
