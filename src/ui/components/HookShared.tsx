import { Box, Text } from "ink";
import type React from "react";
import { useState } from "react";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import type { HookEventName, LoadedHook } from "../../core/hooks/index.ts";
import { errorMessage } from "../../utils/errors.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { Panel } from "./Panel.tsx";
import { SelectRow } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

export function HookPanel({
	title,
	children,
}: {
	title?: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Panel title="Hooks">
			{title ? (
				<Text color={theme.accentBright} bold>
					{title}
				</Text>
			) : null}
			{children}
		</Panel>
	);
}

/** The "+ Add new hook" row shared by the event and matcher selectors. */
export function AddHookRow({
	selected,
}: {
	selected: boolean;
}): React.ReactElement {
	return (
		<SelectRow selected={selected}>
			<Text
				color={selected ? theme.accentBright : theme.accentBright}
				bold={selected}
			>
				+ Add new hook
			</Text>
		</SelectRow>
	);
}

export interface DeleteConfirmation {
	confirming: boolean;
	deleting: boolean;
	error: string | null;
	canDelete: boolean;
	requestConfirm: () => void;
	cancelConfirm: () => void;
	performDelete: (hook: LoadedHook) => void;
}

/** Confirm/delete/error state shared by the hook list and detail views. */
export function useDeleteConfirmation(
	onDelete?: (hook: LoadedHook) => Promise<void>,
): DeleteConfirmation {
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return {
		confirming,
		deleting,
		error,
		canDelete: Boolean(onDelete),
		requestConfirm: () => {
			setError(null);
			setConfirming(true);
		},
		cancelConfirm: () => {
			setConfirming(false);
			setError(null);
		},
		performDelete: (hook: LoadedHook) => {
			if (!onDelete) return;
			setDeleting(true);
			setError(null);
			onDelete(hook)
				.catch((err) => setError(errorMessage(err)))
				.finally(() => {
					setDeleting(false);
					setConfirming(false);
				});
		},
	};
}

export function DeleteConfirmationStatus({
	hook,
	state,
}: {
	hook: LoadedHook | undefined;
	state: DeleteConfirmation;
}): React.ReactElement {
	return (
		<>
			<ErrorLine error={state.error} />
			{state.confirming ? (
				<Box marginTop={1}>
					<Text color={theme.error}>
						{hook?.source.kind === "project"
							? "Delete this project hook (shared)? y / n"
							: "Delete this personal hook? y / n"}
					</Text>
				</Box>
			) : null}
			{state.deleting ? <Spinner label="Removing hook" /> : null}
		</>
	);
}

export function hookHelpLines(event: HookEventName): string[] {
	switch (event) {
		case "PreToolUse":
			return [
				'Input to command is JSON with fields "tool_name" and "tool_input".',
				"Exit code 0 - hook passes, tool executes normally",
				"Exit code 2 - block tool execution and show stderr to the model",
				"Other exit codes - show stderr to user only",
			];
		case "PostToolUse":
			return [
				'Input to command is JSON with fields "tool_name", "tool_input", and "tool_response".',
				"Exit code 0 - hook passes, tool output continues",
				"Exit code 2 - replace tool output with stderr for the model",
				"Other exit codes - show stderr to user only",
			];
		case "UserPromptSubmit":
			return [
				'Input to command is JSON with field "prompt".',
				"Exit code 0 - prompt continues normally",
				"Exit code 2 - block the prompt and show stderr",
				"Other exit codes - show stderr to user only",
			];
		case "SessionStart":
			return [
				'Input to command is JSON with field "source".',
				"Exit code 0 - session continues normally",
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
		case "Stop":
			return [
				'Input to command is JSON with fields "turn_id" and "status".',
				"Runs when a turn ends (completed, failed, or cancelled).",
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
		case "SessionEnd":
			return [
				'Input to command is JSON with field "reason".',
				`Runs when the ${APP_DISPLAY_NAME} session ends.`,
				"Exit code 2 - show stderr as a hook warning",
				"Other exit codes - show stderr to user only",
			];
	}
}
