import { Box, Text, useInput } from "ink";
import type React from "react";
import { useEffect, useMemo, useReducer } from "react";
import type { AskUserRequest } from "../../core/bus/events.ts";
import { sanitizeForTerminal } from "../../utils/terminalSafe.ts";
import {
	deletePromptInputCharacterAtCursor,
	deletePromptInputCharacterBeforeCursor,
	emptyPromptInputEdit,
	insertPromptInputText,
	movePromptInputCursorLeft,
	movePromptInputCursorRight,
} from "../input/PromptInputEditing.ts";
import type { PromptInputEdit } from "../input/types.ts";
import { theme } from "../theme/theme.ts";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import {
	movePickerSelection,
	normalizePickerSelection,
	type PickerSelection,
	resetPickerSelection,
} from "./Picker.tsx";
import { SelectCaret } from "./SelectRow.tsx";

interface Props {
	request: AskUserRequest;
	onComplete: (id: string, answers: string[]) => void;
}

type Question = AskUserRequest["questions"][number];

const VISIBLE_OPTIONS = 8;

export function sanitizeQuestion(question: Question): Question {
	return {
		...question,
		question: sanitizeForTerminal(question.question),
		options: question.options.map(sanitizeForTerminal),
		...(question.header === undefined
			? {}
			: { header: sanitizeForTerminal(question.header) }),
	};
}

/** Resolve the answer for a single question: a typed draft wins, else the
 * highlighted option, else empty. */
export function resolveAnswer(
	draft: string,
	options: string[],
	selectionIndex: number,
): string {
	const trimmed = draft.trim();
	if (trimmed.length > 0) return trimmed;
	return options[selectionIndex] ?? "";
}

/** Index of the next unanswered question after `from`, wrapping around; -1 if
 * every question is answered. */
export function nextUnanswered(answered: boolean[], from: number): number {
	const count = answered.length;
	for (let step = 1; step <= count; step++) {
		const index = (from + step) % count;
		if (!answered[index]) return index;
	}
	return -1;
}

function optionSelectionIndex(
	selection: PickerSelection,
	optionCount: number,
): number {
	return normalizePickerSelection(selection, optionCount, VISIBLE_OPTIONS)
		.itemIndex;
}

function replaceAt<T>(items: readonly T[], index: number, value: T): T[] {
	const next = [...items];
	next[index] = value;
	return next;
}

/**
 * All interactive state lives in one reducer so keystrokes and the
 * confirm/submit that may share a React batch apply in order — a typed answer
 * can never be lost to a stale render closure.
 */
interface AskState {
	current: number;
	edits: PromptInputEdit[];
	selections: PickerSelection[];
	answered: boolean[];
	/** Answer snapshotted at confirm time so later edits to an already-confirmed
	 * question don't change what gets submitted unless it is re-confirmed. */
	answers: string[];
	/** Set once every question is answered; an effect then fires onComplete. */
	submitted: string[] | null;
}

type AskAction =
	| { type: "insert"; text: string }
	| { type: "backspace" }
	| { type: "deleteForward" }
	| { type: "cursorLeft" }
	| { type: "cursorRight" }
	| { type: "moveOption"; direction: "up" | "down" }
	| { type: "confirm" };

/** Move to a question and park the cursor at the end of its draft. */
function goToQuestion(state: AskState, index: number): AskState {
	const edit = state.edits[index] ?? emptyPromptInputEdit();
	return {
		...state,
		current: index,
		edits: replaceAt(state.edits, index, {
			value: edit.value,
			cursorOffset: edit.value.length,
		}),
	};
}

/** The answer for `index` from its current draft/selection. */
function resolveAt(
	state: AskState,
	questions: Question[],
	index: number,
): string {
	const q = questions[index];
	if (!q) return "";
	return resolveAnswer(
		state.edits[index]?.value ?? "",
		q.options,
		optionSelectionIndex(
			state.selections[index] ?? resetPickerSelection(),
			q.options.length,
		),
	);
}

function initState(questions: Question[]): AskState {
	return {
		current: 0,
		edits: questions.map(() => emptyPromptInputEdit()),
		selections: questions.map(() => resetPickerSelection()),
		answered: questions.map(() => false),
		answers: questions.map(() => ""),
		submitted: null,
	};
}

function makeReducer(questions: Question[]) {
	return function reducer(state: AskState, action: AskAction): AskState {
		const { current } = state;
		const edit = state.edits[current] ?? emptyPromptInputEdit();
		const optionCount = questions[current]?.options.length ?? 0;

		switch (action.type) {
			case "insert": {
				// Single-line field: drop newlines; insert normalizes the rest
				// (tabs -> spaces, other control characters stripped).
				const text = action.text.replace(/[\r\n]+/g, "");
				return {
					...state,
					edits: replaceAt(
						state.edits,
						current,
						insertPromptInputText(edit, text),
					),
				};
			}
			case "backspace":
				return {
					...state,
					edits: replaceAt(
						state.edits,
						current,
						deletePromptInputCharacterBeforeCursor(edit),
					),
				};
			case "deleteForward":
				return {
					...state,
					edits: replaceAt(
						state.edits,
						current,
						deletePromptInputCharacterAtCursor(edit),
					),
				};
			case "cursorLeft":
				if (edit.cursorOffset > 0) {
					return {
						...state,
						edits: replaceAt(
							state.edits,
							current,
							movePromptInputCursorLeft(edit),
						),
					};
				}
				// At the start of the draft, step to the previous question.
				return current > 0 ? goToQuestion(state, current - 1) : state;
			case "cursorRight":
				if (edit.cursorOffset < edit.value.length) {
					return {
						...state,
						edits: replaceAt(
							state.edits,
							current,
							movePromptInputCursorRight(edit),
						),
					};
				}
				// At the end of the draft, step to the next question.
				return current < questions.length - 1
					? goToQuestion(state, current + 1)
					: state;
			case "moveOption": {
				// While a custom draft is active the highlight is hidden, so moving
				// it would only surprise the user when they later clear the draft.
				if (edit.value.trim().length > 0) return state;
				return {
					...state,
					selections: replaceAt(
						state.selections,
						current,
						movePickerSelection(
							state.selections[current] ?? resetPickerSelection(),
							optionCount,
							action.direction,
							VISIBLE_OPTIONS,
						),
					),
				};
			}
			case "confirm": {
				// Snapshot this question's answer so it is locked in unless the
				// user comes back and re-confirms it.
				const answers = replaceAt(
					state.answers,
					current,
					resolveAt(state, questions, current),
				);
				const answered = replaceAt(state.answered, current, true);
				const withAnswer = { ...state, answered, answers };
				const next = nextUnanswered(answered, current);
				if (next === -1) {
					return { ...withAnswer, submitted: answers };
				}
				return goToQuestion(withAnswer, next);
			}
		}
	};
}

export function AskUserPrompt({
	request,
	onComplete,
}: Props): React.ReactElement {
	const questions = useMemo(
		() => request.questions.map(sanitizeQuestion),
		[request.questions],
	);
	const [state, dispatch] = useReducer(
		makeReducer(questions),
		questions,
		initState,
	);

	useEffect(() => {
		if (state.submitted) onComplete(request.id, state.submitted);
	}, [state.submitted, onComplete, request.id]);

	const { current, answered } = state;
	const activeQuestion = questions[current];
	const options = activeQuestion?.options ?? [];
	const normalized = normalizePickerSelection(
		state.selections[current] ?? resetPickerSelection(),
		options.length,
		VISIBLE_OPTIONS,
	);
	const safeIndex = normalized.itemIndex;
	const windowStart = normalized.windowStart;
	const visible = options.slice(windowStart, windowStart + VISIBLE_OPTIONS);
	const edit = state.edits[current] ?? emptyPromptInputEdit();
	const draft = edit.value;
	const cursorPos = Math.max(0, Math.min(edit.cursorOffset, draft.length));
	const remaining = answered.filter((a) => !a).length;

	useInput((input, key) => {
		if (questions.length === 0) return;

		if (key.leftArrow) {
			dispatch({ type: "cursorLeft" });
			return;
		}
		if (key.rightArrow) {
			dispatch({ type: "cursorRight" });
			return;
		}
		if (key.upArrow) {
			dispatch({ type: "moveOption", direction: "up" });
			return;
		}
		if (key.downArrow) {
			dispatch({ type: "moveOption", direction: "down" });
			return;
		}
		if (key.return) {
			dispatch({ type: "confirm" });
			return;
		}
		if (key.backspace) {
			dispatch({ type: "backspace" });
			return;
		}
		if (key.delete) {
			dispatch({ type: "deleteForward" });
			return;
		}
		// Ignore control chords; insert printable characters at the cursor.
		if (input && !key.ctrl && !key.meta && !key.tab && !key.escape) {
			dispatch({ type: "insert", text: input });
		}
	});

	if (!activeQuestion) return <Box />;

	const multi = questions.length > 1;
	const selectedOption = options[safeIndex] ?? "";
	const draftActive = draft.trim().length > 0;
	const before = draft.slice(0, cursorPos);
	const atCursor = draft.slice(cursorPos, cursorPos + 1) || " ";
	const after = draft.slice(cursorPos + 1);

	return (
		<Panel>
			{multi ? (
				<Box marginBottom={1} flexWrap="wrap">
					{questions.map((q, index) => {
						const active = index === current;
						const isAnswered = answered[index] ?? false;
						const label = q.header?.trim() || `Q${index + 1}`;
						const color = active
							? theme.accentBright
							: isAnswered
								? theme.subtle
								: theme.text;
						return (
							<Box key={`${label}:${q.question}`}>
								{index > 0 ? (
									<Text color={theme.subtleDecoration}> › </Text>
								) : null}
								<Text
									color={color}
									bold={active}
									strikethrough={isAnswered && !active}
								>
									{label}
								</Text>
							</Box>
						);
					})}
				</Box>
			) : (
				<Box marginBottom={1}>
					<Text color={theme.accentBright} bold>
						{activeQuestion.header?.trim() || "Select Option"}
					</Text>
				</Box>
			)}

			<Box marginBottom={1}>
				<Text color={theme.text}>{activeQuestion.question}</Text>
			</Box>

			<Box flexDirection="column" marginBottom={1}>
				{windowStart > 0 ? <Text color={theme.subtle}>↑ more</Text> : null}
				{visible.map((option, index) => {
					const absoluteIndex = windowStart + index;
					const selected = absoluteIndex === safeIndex && !draftActive;
					return (
						<Box key={`${option}:${absoluteIndex}`}>
							<SelectCaret selected={selected} />
							<Text
								color={selected ? theme.accentBright : theme.text}
								bold={selected}
							>
								{option}
							</Text>
						</Box>
					);
				})}
				{windowStart + VISIBLE_OPTIONS < options.length ? (
					<Text color={theme.subtle}>
						↓ {options.length - windowStart - VISIBLE_OPTIONS} more
					</Text>
				) : null}
				{options.length === 0 ? (
					<Text color={theme.subtle}>No options.</Text>
				) : null}
			</Box>

			<Box>
				<Text color={theme.subtle}>Answer: </Text>
				<Text color={theme.text}>{before}</Text>
				<Text inverse>{atCursor}</Text>
				<Text color={theme.text}>{after}</Text>
				{draft.length === 0 ? (
					<Text color={theme.subtleDecoration}>
						{selectedOption ? ` (${selectedOption})` : " type an answer"}
					</Text>
				) : null}
			</Box>

			<HintFooter
				hints={[
					"↑/↓ choose",
					"type to answer",
					multi && "←/→ move/switch",
					multi ? `Enter confirm (${remaining} left)` : "Enter submit",
				]}
			/>
		</Panel>
	);
}

export function askUserOptionWindowStart(
	selectedIndex: number,
	optionCount: number,
): number {
	return normalizePickerSelection(
		{ itemIndex: selectedIndex, windowStart: 0 },
		optionCount,
		VISIBLE_OPTIONS,
	).windowStart;
}
