import { Box, Text, useInput } from "ink";
import type React from "react";
import { useMemo, useState } from "react";
import { theme } from "../theme/theme.ts";
import {
	SELECT_CARET_PLACEHOLDER,
	SELECT_CARET_PREFIX,
} from "./Glyphs.constants.ts";
import { HintFooter } from "./HintFooter.tsx";
import {
	ALL_TOOLS_OPTION,
	completeSegment,
	filterSuggestions,
} from "./matcherSuggestions.ts";

interface Props {
	toolNames: readonly string[];
	initialValue?: string;
	onSubmit: (matcher: string) => void;
	onCancel: () => void;
}

const MAX_SUGGESTIONS = 8;

export function MatcherAutocomplete({
	toolNames,
	initialValue,
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const [value, setValue] = useState(initialValue ?? "");
	const [highlight, setHighlight] = useState(0);
	const suggestions = useMemo(
		() => filterSuggestions(value, toolNames),
		[value, toolNames],
	);
	const total = suggestions.length;
	const safeHighlight = Math.min(highlight, Math.max(0, total - 1));
	const offset =
		total > MAX_SUGGESTIONS
			? Math.min(
					Math.max(0, safeHighlight - Math.floor(MAX_SUGGESTIONS / 2)),
					total - MAX_SUGGESTIONS,
				)
			: 0;
	const visible = suggestions.slice(offset, offset + MAX_SUGGESTIONS);

	useInput((input, key) => {
		if (key.escape) {
			onCancel();
			return;
		}
		if (key.return) {
			const choice = suggestions[safeHighlight];
			const next = choice ? completeSegment(value, choice) : value;
			onSubmit(next.trim());
			return;
		}
		if (key.tab) {
			const choice = suggestions[safeHighlight];
			if (choice) {
				setValue(completeSegment(value, choice));
				setHighlight(0);
			}
			return;
		}
		if (key.upArrow) {
			setHighlight((index) => (index <= 0 ? total - 1 : index - 1));
			return;
		}
		if (key.downArrow) {
			setHighlight((index) => (index >= total - 1 ? 0 : index + 1));
			return;
		}
		if (key.backspace || key.delete) {
			setValue((current) => current.slice(0, -1));
			setHighlight(0);
			return;
		}
		if (input && !key.ctrl && !key.meta) {
			setValue((current) => current + input);
			setHighlight(0);
		}
	});

	return (
		<Box flexDirection="column">
			<Box>
				<Text color={theme.subtle}>Matcher: </Text>
				<Text color={theme.text}>{value}</Text>
				<Text color={theme.accentBright}>█</Text>
			</Box>
			<Box flexDirection="column" marginTop={1}>
				<Text color={theme.subtle}>
					Suggestions (Tab to complete)
					{total > 0 ? ` · ${safeHighlight + 1}/${total}` : ""}:
				</Text>
				{total === 0 ? (
					<Text color={theme.subtle}> (no matching tools)</Text>
				) : (
					visible.map((suggestion, index) => {
						const absolute = offset + index;
						const active = absolute === safeHighlight;
						const arrow =
							index === 0 && offset > 0
								? "↑"
								: index === visible.length - 1 &&
										offset + MAX_SUGGESTIONS < total
									? "↓"
									: " ";
						return (
							<Box key={suggestion}>
								<Text color={active ? theme.accentBright : theme.subtle}>
									{arrow}{" "}
								</Text>
								<Text
									color={active ? theme.accentBright : theme.text}
									bold={active}
								>
									{active ? SELECT_CARET_PREFIX : SELECT_CARET_PLACEHOLDER}
									{suggestion === ALL_TOOLS_OPTION
										? "All tools (*)"
										: suggestion}
								</Text>
							</Box>
						);
					})
				)}
			</Box>
			<HintFooter
				hints={["Enter select", "Tab complete", "↑/↓ choose", "Esc cancel"]}
			/>
		</Box>
	);
}
