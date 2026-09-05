import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { ProviderKeyController } from "../../core/keys/ProviderKeyController.ts";
import type { ProviderKeyStatus } from "../../core/keys/ProviderKeyTypes.ts";
import {
	type BuiltinProviderId,
	BYOK_PROVIDER_IDS,
} from "../../core/keys/ProviderKeyTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { CustomProviderSetup } from "./CustomProviderSetup.tsx";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { ProviderKeySetup } from "./ProviderKeySetup.tsx";
import { SelectRow } from "./SelectRow.tsx";

interface Props {
	controller: ProviderKeyController;
	/** True when a Backboard sign-in is also active; changes the footer hint. */
	signedIn: boolean;
	onClose: (message?: string) => void;
}

/**
 * `/providers` (with `/keys` as an alias). Built-ins expose key management;
 * custom providers expose their complete connection definition.
 */
export function ProviderKeyManager({
	controller,
	signedIn,
	onClose,
}: Props): React.ReactElement {
	const [statuses, setStatuses] = useState<ProviderKeyStatus[]>(() =>
		controller.list(),
	);
	const selection = useListSelection(statuses.length + 1);
	const [adding, setAdding] = useState<BuiltinProviderId | null>(null);
	const [editingCustom, setEditingCustom] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const current = statuses[Math.min(selection.index, statuses.length - 1)];
	const addSelected = selection.index === statuses.length;

	const refresh = (message: string): void => {
		setStatuses(controller.list());
		setNotice(message);
		setError(null);
	};

	const run = (action: Promise<unknown>, message: string): void => {
		action
			.then(() => refresh(message))
			.catch((err) => setError(errorMessage(err)));
	};

	useInput((input, key) => {
		if (adding || editingCustom) return;
		if (key.escape) {
			onClose();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (key.return) {
			if (addSelected) {
				setEditingCustom("__new__");
				return;
			}
			if (!current) return;
			if (current.custom) {
				setEditingCustom(current.provider);
				return;
			}
			if (!isBuiltinProvider(current.provider)) return;
			setAdding(current.provider);
			setError(null);
			setNotice(null);
			return;
		}
		if (!current || addSelected) return;
		if (input === " ") {
			if (!current.configured) {
				setError(`No ${current.label} key saved yet - press Enter to add one.`);
				return;
			}
			run(
				controller.toggle(current.provider),
				`${current.label} key ${current.enabled ? "disabled" : "enabled"}.`,
			);
			return;
		}
		if (input === "d" && current.configured) {
			run(
				controller.remove(current.provider),
				`Removed the ${current.label} key.`,
			);
		}
	});

	if (editingCustom) {
		return (
			<CustomProviderSetup
				controller={controller}
				{...(editingCustom === "__new__"
					? {}
					: { existing: controller.definition(editingCustom) })}
				onDone={(provider) => {
					setEditingCustom(null);
					refresh(
						`${controller.definition(provider)?.name ?? provider} saved and enabled.`,
					);
				}}
				onCancel={() => setEditingCustom(null)}
			/>
		);
	}

	if (adding) {
		return (
			<ProviderKeySetup
				controller={controller}
				provider={adding}
				onDone={(provider) => {
					setAdding(null);
					const label =
						statuses.find((entry) => entry.provider === provider)?.label ??
						provider;
					refresh(`${label} key saved and enabled.`);
				}}
				onCancel={() => setAdding(null)}
			/>
		);
	}

	return (
		<Panel>
			<Text color={theme.text} bold>
				Model Providers
			</Text>
			<Text color={theme.subtle}>
				{signedIn
					? "Enabled direct providers take precedence over matching Backboard models."
					: "At least one enabled provider is required."}{" "}
				Static keys are encrypted at rest.
			</Text>
			<Box flexDirection="column" marginTop={1}>
				{statuses.map((status, position) => {
					const active = position === selection.index;
					return (
						<SelectRow key={status.provider} selected={active}>
							<Text
								color={
									status.enabled
										? theme.success
										: status.configured
											? theme.subtle
											: theme.subtleDecoration
								}
							>
								{status.enabled ? "●" : status.configured ? "○" : "·"}{" "}
							</Text>
							<Text
								color={active ? theme.accentBright : theme.text}
								bold={active}
							>
								{status.label.padEnd(16)}
							</Text>
							<Text color={status.error ? theme.error : theme.subtle}>
								{status.masked.padEnd(18)}
							</Text>
							<Text color={status.enabled ? theme.success : theme.subtle}>
								{status.configured
									? status.enabled
										? "enabled"
										: "disabled"
									: "not set"}
							</Text>
						</SelectRow>
					);
				})}
				<SelectRow selected={addSelected}>
					<Text
						color={addSelected ? theme.accentBright : theme.text}
						bold={addSelected}
					>
						+ Add custom provider
					</Text>
				</SelectRow>
			</Box>
			{current?.error && !error ? (
				<Box marginTop={1}>
					<ErrorLine error={current.error} />
				</Box>
			) : null}
			{error ? (
				<Box marginTop={1}>
					<ErrorLine error={error} />
				</Box>
			) : null}
			{notice && !error ? (
				<Box marginTop={1}>
					<Text color={theme.success}>{notice}</Text>
				</Box>
			) : null}
			<HintFooter
				hints={[
					"↑/↓ move",
					"Enter add/edit",
					"Space enable/disable",
					"d remove",
					"Esc close",
				]}
			/>
		</Panel>
	);
}

function isBuiltinProvider(provider: string): provider is BuiltinProviderId {
	return (BYOK_PROVIDER_IDS as readonly string[]).includes(provider);
}
