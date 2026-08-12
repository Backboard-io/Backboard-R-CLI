import { Box, Text, useInput, usePaste } from "ink";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { detectAttachmentPaste } from "../../core/attachments/attachmentPaths.ts";
import { readClipboardImage } from "../../core/attachments/clipboardImage.ts";
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENTS_PER_MESSAGE,
} from "../../core/attachments/constants.ts";
import { slashCommandSuggestions } from "../commands/index.ts";
import {
	droppedAttachmentChipIds,
	type PromptInputAttachmentChips,
} from "../input/PromptInputChips.ts";
import {
	emptyPromptInputEdit,
	promptInputLines,
} from "../input/PromptInputEditing.ts";
import { emptyPromptHistoryState } from "../input/PromptInputHistory.ts";
import { resolvePromptInputKeyAction } from "../input/PromptInputKeyRouter.ts";
import type { PromptInputPastePreviews } from "../input/PromptInputPastePreview.ts";
import {
	applyPromptInputAction,
	applyPromptInputAttachments,
	applyPromptInputPaste,
	type PromptInputState,
} from "../input/PromptInputState.ts";
import { useTheme } from "../theme/ThemeProvider.tsx";
import { theme } from "../theme/theme.ts";
import type {
	PromptHistoryState,
	PromptInputEdit,
	PromptInputProps,
} from "./PromptInput.types.ts";
import { PromptSurface } from "./PromptSurface.tsx";

export {
	emptyPromptHistoryState,
	nextPromptHistory,
	previousPromptHistory,
	recordPromptHistory,
	shouldRecallPromptHistoryOnUp,
} from "../input/PromptInputHistory.ts";

export function PromptInput({
	disabled,
	busy,
	queuedPrompts = [],
	allowCommand,
	promptHistory,
	onPromptHistoryChange,
	onSubmit,
	onAttachFiles,
	onRemoveAttachment,
	onNotice,
}: PromptInputProps): React.ReactElement {
	const [edit, setEdit] = useState<PromptInputEdit>(emptyPromptInputEdit);
	const [localHistory, setLocalHistory] = useState<PromptHistoryState>(
		emptyPromptHistoryState,
	);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [pastePreviews, setPastePreviews] = useState<PromptInputPastePreviews>(
		[],
	);
	const [attachmentChips, setAttachmentChips] =
		useState<PromptInputAttachmentChips>([]);
	const uiTheme = useTheme();
	const value = edit.value;
	const history = promptHistory ?? localHistory;
	const setPromptHistory = (nextHistory: PromptHistoryState): void => {
		if (onPromptHistoryChange) {
			onPromptHistoryChange(nextHistory);
			return;
		}
		setLocalHistory(nextHistory);
	};
	const suggestions = useMemo(
		() =>
			disabled || busy ? [] : slashCommandSuggestions(value, { allowCommand }),
		[allowCommand, busy, disabled, value],
	);
	const selectedSuggestion =
		suggestions[Math.min(selectedIndex, Math.max(0, suggestions.length - 1))];
	const currentInputState = (): PromptInputState => ({
		edit,
		history,
		pastePreviews,
		attachments: attachmentChips,
		selectedIndex,
	});
	const commitInputState = (
		current: PromptInputState,
		next: PromptInputState,
		options: { notifyRemovals?: boolean } = {},
	): void => {
		if (next === current) return;
		setEdit(next.edit);
		setPastePreviews(next.pastePreviews);
		setAttachmentChips(next.attachments);
		setSelectedIndex(next.selectedIndex);
		if (next.history !== history) setPromptHistory(next.history);
		if (options.notifyRemovals !== false && onRemoveAttachment) {
			const remaining = next.attachments.filter((chip) =>
				next.edit.value.includes(chip.label),
			);
			if (remaining.length !== next.attachments.length) {
				setAttachmentChips(remaining);
			}
			for (const id of droppedAttachmentChipIds(
				current.attachments,
				remaining,
			)) {
				onRemoveAttachment(id);
			}
		}
	};

	const latestInputState = useRef(currentInputState);
	latestInputState.current = currentInputState;
	const latestCommitInputState = useRef(commitInputState);
	latestCommitInputState.current = commitInputState;
	const clipboardPasteBusy = useRef(false);

	const pasteClipboardImage = async (): Promise<void> => {
		if (!onAttachFiles || clipboardPasteBusy.current) return;
		clipboardPasteBusy.current = true;
		try {
			const result = await readClipboardImage();
			if (result.kind === "none") {
				onNotice?.("No image found in clipboard", "error");
				return;
			}
			if (result.kind === "too-large") {
				onNotice?.(
					`Skipped clipboard image: file exceeds the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB limit`,
					"error",
				);
				return;
			}
			const state = latestInputState.current();
			if (state.attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
				onNotice?.(
					`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments — skipped the clipboard image`,
					"error",
				);
				return;
			}
			const chips = onAttachFiles([result.file]).map((item) => ({
				id: item.id,
				label: item.label,
				fileName: item.fileName,
				filePath: item.filePath,
			}));
			latestCommitInputState.current(
				state,
				applyPromptInputAttachments(state, chips),
			);
		} finally {
			clipboardPasteBusy.current = false;
		}
	};

	usePaste(
		(text) => {
			if (disabled) return;
			const state = currentInputState();
			if (onAttachFiles) {
				const detected = detectAttachmentPaste(text);
				if (detected.kind === "attachments") {
					for (const rejectedFile of detected.rejected) {
						onNotice?.(
							`Skipped ${rejectedFile.filePath}: ${rejectedFile.reason}`,
							"error",
						);
					}
					const budget = MAX_ATTACHMENTS_PER_MESSAGE - state.attachments.length;
					const accepted = detected.accepted.slice(0, Math.max(0, budget));
					if (accepted.length < detected.accepted.length) {
						onNotice?.(
							`A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments — skipped ${detected.accepted.length - accepted.length} file(s)`,
							"error",
						);
					}
					let next = state;
					if (accepted.length > 0) {
						const chips = onAttachFiles(accepted).map((item) => ({
							id: item.id,
							label: item.label,
							fileName: item.fileName,
							filePath: item.filePath,
						}));
						next = applyPromptInputAttachments(next, chips);
					}
					// Keep any prose that was pasted alongside the path(s).
					if (detected.remainingText) {
						next = applyPromptInputPaste(next, detected.remainingText);
					}
					if (next !== state) commitInputState(state, next);
					return;
				}
			}
			commitInputState(state, applyPromptInputPaste(state, text));
		},
		{ isActive: !disabled },
	);

	useInput(
		(input, key) => {
			if (disabled) return;
			const action = resolvePromptInputKeyAction(input, key, {
				busy: Boolean(busy),
				cursorOffset: edit.cursorOffset,
				platform: process.platform,
				suggestionsVisible: suggestions.length > 0,
				value,
			});
			const state = currentInputState();
			const result = applyPromptInputAction(state, {
				action,
				selectedSuggestion,
				suggestionsLength: suggestions.length,
			});
			if (result.effect.kind === "pasteClipboardImage") {
				void pasteClipboardImage();
				return;
			}
			if (result.effect.kind === "submit") {
				onSubmit(
					result.effect.value,
					result.effect.intent,
					result.effect.attachmentIds,
				);
				commitInputState(state, result.state, { notifyRemovals: false });
				return;
			}
			commitInputState(state, result.state);
		},
		{ isActive: !disabled },
	);

	return (
		<Box flexDirection="column" marginTop={1} width="100%">
			{queuedPrompts.length > 0 ? (
				<QueuedPromptList prompts={queuedPrompts} />
			) : null}
			<PromptSurface state={value.trim() ? "active" : "idle"}>
				{disabled ? (
					<Box>
						<Text color={theme.inputPlaceholder}>
							(working - press Ctrl+C to interrupt)
						</Text>
					</Box>
				) : (
					<Box>
						{renderEditablePrompt(
							value,
							edit.cursorOffset,
							"",
							uiTheme.readableSecondaryText,
						)}
					</Box>
				)}
			</PromptSurface>
			{busy ? (
				<Box paddingX={1}>
					<Text color={theme.subtle}>Tab to queue · Enter to steer</Text>
				</Box>
			) : null}
			{suggestions.length > 0 ? (
				<Box flexDirection="column" paddingX={1}>
					{suggestions.map((suggestion) => {
						const selected = suggestion === selectedSuggestion;
						return (
							<Box key={suggestion.command}>
								<Text
									color={selected ? theme.accentBright : theme.subtle}
									bold={selected}
								>
									{suggestion.command.padEnd(14)}
								</Text>
								<Text color={selected ? theme.text : theme.subtle}>
									{suggestion.description}
								</Text>
							</Box>
						);
					})}
				</Box>
			) : null}
		</Box>
	);
}

function QueuedPromptList({
	prompts,
}: {
	prompts: NonNullable<PromptInputProps["queuedPrompts"]>;
}): React.ReactElement {
	return (
		<Box flexDirection="column" marginBottom={1} paddingX={1}>
			<Box>
				<Text color={theme.subtle} bold>
					Queued
				</Text>
				<Text color={theme.subtle}> ({prompts.length})</Text>
			</Box>
			{prompts.map((prompt) => (
				<Box key={prompt.id} paddingLeft={1}>
					<Text color={theme.subtle}>-&gt; </Text>
					<Text color={theme.text}>{formatQueuedPrompt(prompt.text)}</Text>
				</Box>
			))}
		</Box>
	);
}

export function formatQueuedPrompt(prompt: string): string {
	const normalized = prompt.replace(/\s+/g, " ").trim();
	return normalized.length > 80
		? `${normalized.slice(0, 77).trimEnd()}...`
		: normalized;
}

function renderEditablePrompt(
	value: string,
	cursorOffset: number,
	placeholder: string,
	placeholderColor: string | undefined,
): React.ReactElement {
	if (value.length === 0) {
		return (
			<Text color={placeholderColor}>
				<Text inverse>{placeholder[0] ?? " "}</Text>
				<Text color={placeholderColor}>{placeholder.slice(1)}</Text>
			</Text>
		);
	}

	let lineStart = 0;
	return (
		<Box flexDirection="column">
			{promptInputLines(value).map((line, index) => {
				const rendered = renderEditableLine(line, lineStart, cursorOffset);
				const key = `${index}:${lineStart}`;
				lineStart += line.length + 1;
				return <Box key={key}>{rendered}</Box>;
			})}
		</Box>
	);
}

function renderEditableLine(
	line: string,
	lineStart: number,
	cursorOffset: number,
): React.ReactElement {
	const cursorColumn =
		cursorOffset >= lineStart && cursorOffset <= lineStart + line.length
			? cursorOffset - lineStart
			: null;
	if (cursorColumn === null) {
		return <Text color={theme.inputText}>{line || " "}</Text>;
	}

	const before = line.slice(0, cursorColumn);
	const cursor = cursorColumn < line.length ? (line[cursorColumn] ?? " ") : " ";
	const after = cursorColumn < line.length ? line.slice(cursorColumn + 1) : "";
	return (
		<Text color={theme.inputText}>
			<Text>{before}</Text>
			<Text inverse>{cursor}</Text>
			<Text>{after}</Text>
		</Text>
	);
}
