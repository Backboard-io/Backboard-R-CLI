import { Box, Text } from "ink";
import type React from "react";
import { clipEnd } from "../../utils/string.ts";
import { theme } from "../theme/theme.ts";
import { SelectCaret } from "./SelectRow.tsx";
import {
	CardHeader,
	cardHeaderWidths,
	sessionCardLayout,
} from "./SessionCard.tsx";
import type {
	AuthPromptProps,
	AuthPromptSelection,
} from "./TerminalComponents.types.ts";

const ACTIONS: Record<AuthPromptSelection, string> = {
	login: "Login with Backboard",
	byok: "Use my own API key",
	exit: "Exit",
};

const HINTS: Record<AuthPromptSelection, string> = {
	login: "Full model catalog, memory, and saved conversations",
	byok: "Anthropic, OpenAI, or Gemini - billed to your own key",
	exit: "",
};

export function AuthPrompt({
	selected = "login",
	columns,
}: AuthPromptProps): React.ReactElement {
	const layout = sessionCardLayout(columns);
	const { headerTextWidth } = cardHeaderWidths(layout);
	return (
		<Box flexDirection="column">
			<Box
				alignSelf="flex-start"
				borderStyle="round"
				borderColor={theme.accentBright}
				paddingX={layout.paddingX}
				paddingY={1}
				width={layout.cardWidth}
			>
				<CardHeader layout={layout}>
					<Text color={theme.subtle}>
						{clipEnd("Login or signup to use Backboard CLI.", headerTextWidth)}
					</Text>
					<Text color={theme.warning}>
						{clipEnd("Status: Not Connected", headerTextWidth)}
					</Text>
				</CardHeader>
			</Box>
			<Box flexDirection="column" marginTop={1} paddingX={1}>
				<Text color={theme.accentBright}>
					Sign in with Backboard, or bring your own provider API key.
				</Text>
				<Box flexDirection="column" marginTop={1}>
					{Object.entries(ACTIONS).map(([key, label]) => {
						const active = key === selected;
						return (
							<Box key={key}>
								<SelectCaret selected={active} />
								<Text
									color={active ? theme.accentBright : theme.subtle}
									bold={active}
								>
									{label}
								</Text>
							</Box>
						);
					})}
				</Box>
				{/*
				 * One hint line for the highlighted action rather than a hint per
				 * row: the card is narrow, and inline hints wrap into the labels.
				 */}
				{HINTS[selected] ? (
					<Box marginTop={1}>
						<Text color={theme.subtle}>
							{clipEnd(HINTS[selected], headerTextWidth)}
						</Text>
					</Box>
				) : null}
			</Box>
		</Box>
	);
}
