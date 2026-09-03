import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import { errorMessage } from "../../utils/errors.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import type {
	EntryListEditorProps,
	EntryListItem,
} from "./EntryListEditor.types.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { SelectRow } from "./SelectRow.tsx";

type EditField = "key" | "value";

export function EntryListEditor({
	title,
	help,
	entries,
	keyLabel,
	valueLabel,
	keyPlaceholder,
	valuePlaceholder,
	isSecret,
	validate,
	onChange,
	onSubmit,
	onCancel,
}: EntryListEditorProps): React.ReactElement {
	const [editingIndex, setEditingIndex] = useState<number | null>(null);
	const [field, setField] = useState<EditField | null>(null);
	const [draft, setDraft] = useState<EntryListItem>({ key: "", value: "" });
	const [error, setError] = useState<string | null>(null);
	const rowCount = entries.length + 2;
	const selection = useListSelection(rowCount, {
		initialIndex: entries.length,
	});
	const selected = selection.index;
	const setSelected = selection.setIndex;

	const beginEdit = (index: number | null): void => {
		const entry = index === null ? { key: "", value: "" } : entries[index];
		setEditingIndex(index);
		setDraft(entry ?? { key: "", value: "" });
		setField("key");
		setError(null);
	};

	const saveDraft = (): void => {
		const candidate: EntryListItem = {
			...draft,
			key: draft.key.trim(),
			value: draft.value,
		};
		if (!candidate.key) {
			setError(`Enter a ${keyLabel.toLowerCase()}.`);
			setField("key");
			return;
		}
		const duplicate = entries.some(
			(entry, index) =>
				index !== editingIndex &&
				entry.key.toLowerCase() === candidate.key.toLowerCase(),
		);
		if (duplicate) {
			setError(`${candidate.key} is already listed.`);
			setField("key");
			return;
		}
		try {
			validate?.(candidate);
		} catch (err) {
			setError(errorMessage(err));
			return;
		}
		const next = [...entries];
		if (editingIndex === null) next.push(candidate);
		else next[editingIndex] = candidate;
		onChange(next);
		setSelected(editingIndex ?? next.length);
		setEditingIndex(null);
		setField(null);
		setDraft({ key: "", value: "" });
		setError(null);
	};

	useInput((input, key) => {
		if (field) {
			if (key.escape) {
				setEditingIndex(null);
				setField(null);
				setError(null);
			}
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (input === "k") {
			setSelected((index) => (index - 1 + rowCount) % rowCount);
			return;
		}
		if (input === "j") {
			setSelected((index) => (index + 1) % rowCount);
			return;
		}
		if ((input === "d" || key.delete) && selected < entries.length) {
			onChange(entries.filter((_, index) => index !== selected));
			setSelected((index) => Math.min(index, entries.length - 1));
			setError(null);
			return;
		}
		if (!key.return) return;
		if (selected < entries.length) {
			beginEdit(selected);
			return;
		}
		if (selected === entries.length) {
			beginEdit(null);
			return;
		}
		onSubmit();
	});

	if (field) {
		const editingKey = field === "key";
		const secret = !editingKey && (isSecret?.(draft.key) ?? false);
		const label = editingKey ? keyLabel : (valueLabel ?? "Value");
		const value = editingKey ? draft.key : draft.value;
		return (
			<Box flexDirection="column">
				<Text color={theme.accentBright} bold>
					{editingIndex === null ? "Add entry" : "Edit entry"}
				</Text>
				<Box marginTop={1}>
					<Text color={theme.subtle}>{label}: </Text>
					<TextInput
						key={`${editingIndex ?? "new"}-${field}`}
						value={value}
						onChange={(next) => {
							setDraft((current) => ({
								...current,
								[field]: next,
							}));
							setError(null);
						}}
						onSubmit={() => {
							if (editingKey && valueLabel) {
								if (!draft.key.trim()) {
									setError(`Enter a ${keyLabel.toLowerCase()}.`);
									return;
								}
								setField("value");
								setError(null);
								return;
							}
							saveDraft();
						}}
						placeholder={
							editingKey
								? (keyPlaceholder ?? keyLabel.toLowerCase())
								: (valuePlaceholder ?? valueLabel?.toLowerCase() ?? "value")
						}
						{...(secret ? { mask: "•" } : {})}
						focus
					/>
				</Box>
				{secret ? (
					<Text color={theme.subtle}>
						Secret values should use an environment reference.
					</Text>
				) : null}
				<ErrorLine error={error} />
				<HintFooter hints={["Enter next", "Esc list"]} />
			</Box>
		);
	}

	return (
		<Box flexDirection="column">
			<Text color={theme.accentBright} bold>
				{title}
			</Text>
			{help ? <Text color={theme.subtle}>{help}</Text> : null}
			<Box flexDirection="column" marginTop={1}>
				{entries.map((entry, index) => {
					const secret = isSecret?.(entry.key) ?? false;
					return (
						<SelectRow key={entry.key} selected={selected === index}>
							<Text
								color={selected === index ? theme.accentBright : theme.text}
							>
								{entry.key}
								{valueLabel ? `: ${secret ? "(secret)" : entry.value}` : ""}
							</Text>
						</SelectRow>
					);
				})}
				<SelectRow selected={selected === entries.length}>
					<Text
						color={
							selected === entries.length ? theme.accentBright : theme.subtle
						}
					>
						+ Add more
					</Text>
				</SelectRow>
				<SelectRow selected={selected === entries.length + 1}>
					<Text
						color={
							selected === entries.length + 1
								? theme.accentBright
								: theme.subtle
						}
					>
						Done
					</Text>
				</SelectRow>
			</Box>
			<ErrorLine error={error} />
			<HintFooter
				hints={["↑/↓ move", "Enter select", "d delete", "Esc back"]}
			/>
		</Box>
	);
}
