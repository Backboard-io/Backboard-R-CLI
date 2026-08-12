import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import {
	type AddHookInput,
	type HookEventName,
	type HookScope,
	isToolHookEvent,
	validateHookMatcher,
} from "../../core/hooks/index.ts";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { HookPanel } from "./HookShared.tsx";
import { MatcherAutocomplete } from "./MatcherAutocomplete.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	event: HookEventName;
	initialMatcher?: string;
	toolNames: readonly string[];
	onSubmit: (input: AddHookInput) => Promise<void>;
	onCancel: () => void;
}

type Step = "scope" | "matcher" | "command" | "name";

const SCOPES: ReadonlyArray<{ value: HookScope; label: string; hint: string }> =
	[
		{
			value: "user",
			label: "Personal",
			hint: "~/.backboard — all your projects",
		},
		{
			value: "project",
			label: "Project",
			hint: "this repo — shared with the team",
		},
	];

export function HookAddForm({
	event,
	initialMatcher,
	toolNames,
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const [step, setStep] = useState<Step>("scope");
	const [scope, setScope] = useState<HookScope>("user");
	const [matcher, setMatcher] = useState(initialMatcher ?? "");
	const [command, setCommand] = useState("");
	const [name, setName] = useState("");
	const action = useAsyncAction();
	const { setError } = action;

	useInput((_input, key) => {
		if (action.running) return;
		if (step === "scope") {
			if (key.escape) {
				onCancel();
				return;
			}
			if (key.upArrow || key.downArrow) {
				setScope((current) => (current === "user" ? "project" : "user"));
				return;
			}
			if (key.return) {
				setError(null);
				setStep(isToolHookEvent(event) ? "matcher" : "command");
			}
			return;
		}
		if (step !== "matcher" && key.escape) onCancel();
	});

	const submitMatcher = (next: string): void => {
		const matcherError = validateHookMatcher(next);
		setMatcher(next);
		if (matcherError) {
			setError(matcherError);
			return;
		}
		setError(null);
		setStep("command");
	};

	const submitCommand = (): void => {
		if (!command.trim()) {
			setError("Command cannot be empty.");
			return;
		}
		setError(null);
		setStep("name");
	};

	const finish = (): void => {
		action.run("Saving hook", async () => {
			try {
				await onSubmit({
					scope,
					event,
					...(isToolHookEvent(event) ? { matcher: matcher.trim() } : {}),
					command: command.trim(),
					...(name.trim() ? { name: name.trim() } : {}),
				});
			} catch (err) {
				setStep("command");
				throw err;
			}
		});
	};

	return (
		<HookPanel title={`Add hook · ${event}`}>
			{step === "scope" ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.subtle}>
						Where should this hook live? (↑/↓, Enter)
					</Text>
					{SCOPES.map((option) => {
						const active = option.value === scope;
						return (
							<Box key={option.value}>
								<Text
									color={active ? theme.accentBright : theme.text}
									bold={active}
								>
									{active ? "› " : "  "}
									{option.label}
								</Text>
								<Text color={active ? theme.accentBright : theme.subtle}>
									{" "}
									— {option.hint}
								</Text>
							</Box>
						);
					})}
				</Box>
			) : null}
			{step === "matcher" ? (
				<Box marginTop={1}>
					<MatcherAutocomplete
						toolNames={toolNames}
						initialValue={matcher}
						onSubmit={submitMatcher}
						onCancel={onCancel}
					/>
				</Box>
			) : null}
			{step === "command" ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.subtle}>Shell command to run:</Text>
					<Box>
						<Text color={theme.subtle}>Command: </Text>
						<TextInput
							value={command}
							onChange={(next) => {
								setCommand(next);
								setError(null);
							}}
							onSubmit={submitCommand}
							placeholder="./scripts/guard.sh"
							focus
						/>
					</Box>
				</Box>
			) : null}
			{step === "name" ? (
				<Box flexDirection="column" marginTop={1}>
					<Text color={theme.subtle}>Optional name (Enter to skip):</Text>
					<Box>
						<Text color={theme.subtle}>Name: </Text>
						<TextInput
							value={name}
							onChange={(next) => {
								setName(next);
								setError(null);
							}}
							onSubmit={finish}
							placeholder="lint-guard"
							focus
						/>
					</Box>
				</Box>
			) : null}
			<ErrorLine error={action.error} />
			{action.running ? (
				<Spinner label={action.label ?? "Saving hook"} />
			) : null}
			{step === "matcher" ? null : (
				<HintFooter hints={["Enter continue", "Esc cancel"]} />
			)}
		</HookPanel>
	);
}
