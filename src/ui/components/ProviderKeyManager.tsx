import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { ProviderKeyController } from "../../core/keys/ProviderKeyController.ts";
import type {
	ByokProviderId,
	ProviderKeyStatus,
} from "../../core/keys/ProviderKeyTypes.ts";
import { errorMessage } from "../../utils/errors.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
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
 * `/keys`. A flat list with direct-action keys rather than nested menus - there
 * are only a few providers and four verbs, so a submenu would cost a keystroke
 * and buy nothing.
 */
export function ProviderKeyManager({
	controller,
	signedIn,
	onClose,
}: Props): React.ReactElement {
	const [statuses, setStatuses] = useState<ProviderKeyStatus[]>(() =>
		controller.list(),
	);
	const selection = useListSelection(statuses.length);
	const [adding, setAdding] = useState<ByokProviderId | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const current = statuses[Math.min(selection.index, statuses.length - 1)];

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
		if (adding) return;
		if (key.escape) {
			onClose();
			return;
		}
		if (selection.onInput(input, key)) return;
		if (!current) return;
		if (key.return) {
			setAdding(current.provider);
			setError(null);
			setNotice(null);
			return;
		}
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
				API Keys
			</Text>
			<Text color={theme.subtle}>
				{signedIn
					? "Enabled keys take precedence over your Backboard sign-in."
					: "Keys are the only credentials for this session."}{" "}
				Encrypted at rest, bound to this machine.
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
							<Text color={theme.subtle}>{status.masked.padEnd(18)}</Text>
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
			</Box>
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
					"Enter add/replace",
					"Space enable/disable",
					"d remove",
					"Esc close",
				]}
			/>
		</Panel>
	);
}
