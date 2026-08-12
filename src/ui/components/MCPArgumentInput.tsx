import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { SelectRow } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

export interface McpArgumentField {
	name: string;
	description?: string;
	required: boolean;
}

interface Props {
	title: string;
	fields: McpArgumentField[];
	onSubmit: (
		values: Record<string, string>,
		signal: AbortSignal,
	) => Promise<void> | void;
	onCancel: () => void;
}

export function McpArgumentInput({
	title,
	fields,
	onSubmit,
	onCancel,
}: Props): React.ReactElement {
	const [values, setValues] = useState<Record<string, string>>({});
	// Field navigation clamps at the ends rather than wrapping, so it stays
	// local instead of using useListSelection.
	const [fieldIndex, setFieldIndex] = useState(0);
	const asyncAction = useAsyncAction();
	const field = fields[fieldIndex] ?? null;

	useInput((_input, key) => {
		if (asyncAction.running) {
			if (key.escape) asyncAction.cancel();
			return;
		}
		if (key.escape) {
			if (asyncAction.error) {
				asyncAction.setError(null);
				return;
			}
			onCancel();
			return;
		}
		if (key.upArrow) {
			setFieldIndex((index) => Math.max(0, index - 1));
			asyncAction.setError(null);
			return;
		}
		if (key.downArrow) {
			setFieldIndex((index) => Math.min(fields.length - 1, index + 1));
			asyncAction.setError(null);
		}
	});

	const submit = (): void => {
		if (asyncAction.running) return;
		const missing = fields.find(
			(candidate) => candidate.required && !values[candidate.name]?.trim(),
		);
		if (missing) {
			setFieldIndex(fields.indexOf(missing));
			asyncAction.setError(`${missing.name} is required.`);
			return;
		}
		const payload = Object.fromEntries(
			Object.entries(values)
				.map(([key, value]) => [key, value.trim()] as const)
				.filter(([, value]) => value.length > 0),
		);
		asyncAction.run("Loading MCP item", async (signal) => {
			await onSubmit(payload, signal);
		});
	};

	return (
		<Box
			flexDirection="column"
			marginTop={1}
			borderStyle="round"
			borderColor={theme.accentBright}
			paddingX={1}
		>
			<Text color={theme.accentBright} bold>
				{title}
			</Text>
			{fields.map((candidate, index) => {
				const selected = index === fieldIndex;
				const label = `${candidate.name}${candidate.required ? " *" : ""}`;
				return (
					<SelectRow key={candidate.name} selected={selected}>
						<Text
							color={selected ? theme.accentBright : theme.subtle}
							bold={selected}
						>
							{label}
							{values[candidate.name]?.trim()
								? ` = ${values[candidate.name]?.trim()}`
								: ""}
						</Text>
					</SelectRow>
				);
			})}
			{field ? (
				<>
					{field.description ? (
						<Text color={theme.subtle}>{field.description}</Text>
					) : null}
					<Box>
						<Text color={theme.subtle}>{field.name}: </Text>
						<TextInput
							key={field.name}
							value={values[field.name] ?? ""}
							onChange={(value) => {
								setValues((current) => ({ ...current, [field.name]: value }));
								asyncAction.setError(null);
							}}
							onSubmit={submit}
							placeholder={field.required ? "required" : "optional"}
							focus
						/>
					</Box>
				</>
			) : null}
			<ErrorLine error={asyncAction.error} />
			<HintFooter
				marginTop={0}
				hints={["↑/↓ fields", "Enter submit", "Esc cancel"]}
			/>
			{asyncAction.running && asyncAction.label ? (
				<Spinner label={asyncAction.label} />
			) : null}
		</Box>
	);
}
