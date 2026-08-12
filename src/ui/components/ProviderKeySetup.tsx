import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type React from "react";
import { useState } from "react";
import type { ProviderKeyController } from "../../core/keys/ProviderKeyController.ts";
import {
	BYOK_PROVIDER_IDS,
	type ByokProviderId,
	maskProviderKey,
} from "../../core/keys/ProviderKeyTypes.ts";
import {
	BYOK_ADAPTER_LIST,
	BYOK_ADAPTERS,
} from "../../providers/byok/registry.ts";
import { errorMessage } from "../../utils/errors.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { SelectRow } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	controller: ProviderKeyController;
	/** Skips the provider step when the caller already picked one. */
	provider?: ByokProviderId;
	onDone: (provider: ByokProviderId) => void;
	onCancel: () => void;
}

type Step = "provider" | "key";

/**
 * Pick a provider, paste a key, validate, save.
 *
 * Shared verbatim by the first-run BYOK screen and `/keys`, so the two can
 * never drift on validation, masking, or wording.
 */
export function ProviderKeySetup({
	controller,
	provider,
	onDone,
	onCancel,
}: Props): React.ReactElement {
	const [step, setStep] = useState<Step>(provider ? "key" : "provider");
	const selection = useListSelection(BYOK_PROVIDER_IDS.length);
	const selected: ByokProviderId =
		provider ?? BYOK_PROVIDER_IDS[selection.index] ?? BYOK_PROVIDER_IDS[0];
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	const adapter = BYOK_ADAPTERS[selected];
	// Read once, not per render: `list()` re-reads the key file from disk and
	// decrypts every entry, and this component re-renders on each keystroke of
	// the masked input. Nothing can change it while this screen is open - the
	// only writer is this component's own save, which closes it.
	const [statuses] = useState(() => controller.list());

	const submitKey = (): void => {
		if (saving) return;
		const trimmed = value.trim();
		setError(null);
		setSaving(true);
		controller
			.add(selected, trimmed)
			.then(() => {
				setValue("");
				onDone(selected);
			})
			.catch((err) => {
				setError(errorMessage(err));
			})
			.finally(() => setSaving(false));
	};

	useInput((input, key) => {
		if (saving) return;
		if (key.escape) {
			// Esc steps back to the provider list before it closes the flow, so a
			// mistyped provider costs one keystroke instead of restarting.
			if (step === "key" && !provider) {
				setStep("provider");
				setError(null);
				setValue("");
				return;
			}
			onCancel();
			return;
		}
		if (step !== "provider") return;
		if (selection.onInput(input, key)) return;
		if (key.return) {
			setStep("key");
			setError(null);
		}
	});

	if (step === "provider") {
		return (
			<Panel title="Select a provider">
				<Box flexDirection="column">
					{BYOK_ADAPTER_LIST.map((entry) => {
						const status = statuses.find((s) => s.provider === entry.id);
						const active = entry.id === selected;
						return (
							<SelectRow key={entry.id} selected={active}>
								<Text
									color={active ? theme.accentBright : theme.text}
									bold={active}
								>
									{entry.label.padEnd(16)}
								</Text>
								<Text color={theme.subtle}>
									{status?.configured
										? `${status.masked}${status.enabled ? "" : " (disabled)"}`
										: entry.keyHint}
								</Text>
							</SelectRow>
						);
					})}
				</Box>
				<HintFooter hints={["↑/↓ move", "Enter select", "Esc cancel"]} />
			</Panel>
		);
	}

	return (
		<Panel>
			<Text color={theme.text} bold>
				Paste your {adapter.label} API key
			</Text>
			<Text color={theme.subtle}>
				Get one at {adapter.consoleUrl} · stored encrypted in
				~/.backboard/keys.json
			</Text>
			<Box marginTop={1}>
				<Text color={theme.subtle}>Key: </Text>
				{/*
				 * Rendered masked: terminal scrollback outlives the session, and a
				 * pasted key echoed in full would sit in it (and in any recording)
				 * long after this screen closes.
				 */}
				<TextInput
					value={value}
					onChange={(next) => {
						setValue(next);
						setError(null);
					}}
					onSubmit={submitKey}
					placeholder={adapter.keyHint}
					mask="•"
					focus={!saving}
				/>
			</Box>
			{value.trim() && !saving ? (
				<Text color={theme.subtle}>Entered: {maskProviderKey(value)}</Text>
			) : null}
			<ErrorLine error={error} />
			<HintFooter hints={["Enter save", "Esc back"]} />
			{saving ? <Spinner label={`Verifying with ${adapter.label}`} /> : null}
		</Panel>
	);
}
