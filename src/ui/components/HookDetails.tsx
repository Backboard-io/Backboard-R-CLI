import { Box, Text, useInput } from "ink";
import type React from "react";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import type { LoadedHook } from "../../core/hooks/index.ts";
import { theme } from "../theme/theme.ts";
import { withStableKeys } from "../utils/stableKeys.ts";
import { HintFooter } from "./HintFooter.tsx";
import {
	DeleteConfirmationStatus,
	HookPanel,
	useDeleteConfirmation,
} from "./HookShared.tsx";

interface Props {
	hook: LoadedHook;
	onDelete?: (hook: LoadedHook) => Promise<void>;
	onCancel: () => void;
}

export type HookDetailsAction =
	| { type: "none" }
	| { type: "back" }
	| { type: "confirm-delete" }
	| { type: "delete" }
	| { type: "cancel-confirm" };

export function resolveHookDetailsAction(
	input: string,
	key: { escape: boolean; return: boolean },
	state: { confirmingDelete: boolean; deleting: boolean; canDelete: boolean },
): HookDetailsAction {
	if (state.deleting) return { type: "none" };
	if (state.confirmingDelete) {
		if (input.toLowerCase() === "y") return { type: "delete" };
		if (key.escape || input.toLowerCase() === "n") {
			return { type: "cancel-confirm" };
		}
		return { type: "none" };
	}
	if (key.escape || key.return) return { type: "back" };
	if (input.toLowerCase() === "d" && state.canDelete) {
		return { type: "confirm-delete" };
	}
	return { type: "none" };
}

export function HookDetails({
	hook,
	onDelete,
	onCancel,
}: Props): React.ReactElement {
	const deletion = useDeleteConfirmation(onDelete);

	useInput((input, key) => {
		const action = resolveHookDetailsAction(input, key, {
			confirmingDelete: deletion.confirming,
			deleting: deletion.deleting,
			canDelete: deletion.canDelete,
		});
		switch (action.type) {
			case "back":
				return onCancel();
			case "confirm-delete":
				return deletion.requestConfirm();
			case "cancel-confirm":
				return deletion.cancelConfirm();
			case "delete":
				return deletion.performDelete(hook);
			case "none":
				return;
		}
	});

	return (
		<HookPanel title="Hook details">
			<Box marginTop={1} flexDirection="column">
				<DetailLine label="Event" value={hook.event} />
				<DetailLine label="Matcher" value={hook.matcher ?? "*"} />
				<DetailLine label="Source" value={hookSourceDetailLabel(hook)} subtle />
			</Box>
			<Box marginTop={1}>
				<Text color={theme.subtle}>Command:</Text>
			</Box>
			<Box flexDirection="column" marginTop={1} marginLeft={2}>
				{commandLines(hook.hook.command).map((line) => (
					<Text key={line.key} color={theme.text}>
						{line.item}
					</Text>
				))}
			</Box>
			<Box marginTop={1}>
				<Text color={theme.subtle}>
					To modify this hook, edit hooks.json directly or ask{" "}
					{APP_DISPLAY_NAME}.
				</Text>
			</Box>
			<DeleteConfirmationStatus hook={hook} state={deletion} />
			<HintFooter hints={[Boolean(onDelete) && "d delete", "Esc back"]} />
		</HookPanel>
	);
}

function DetailLine({
	label,
	value,
	subtle = false,
}: {
	label: string;
	value: string;
	subtle?: boolean;
}): React.ReactElement {
	return (
		<Box>
			<Text color={theme.text} bold>
				{`${label}:`.padEnd(10)}
			</Text>
			<Text color={subtle ? theme.subtle : theme.text}>{value}</Text>
		</Box>
	);
}

function hookSourceDetailLabel(hook: LoadedHook): string {
	return `${hook.source.kind} hooks (${hook.source.path})`;
}

function commandLines(command: string): Array<{ key: string; item: string }> {
	return withStableKeys(command.split("\n"), (line) => line);
}
