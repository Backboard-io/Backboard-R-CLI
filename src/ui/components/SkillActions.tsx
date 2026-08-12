import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type {
	SkillInstallTarget,
	SkillPickerItem,
} from "../../core/skills/SkillController.ts";
import { useAsyncAction } from "../hooks/useAsyncAction.ts";
import { useListSelection } from "../hooks/useListSelection.ts";
import { theme } from "../theme/theme.ts";
import { ErrorLine } from "./ErrorLine.tsx";
import { HintFooter } from "./HintFooter.tsx";
import { Panel } from "./Panel.tsx";
import { SelectCaret, SelectRow } from "./SelectRow.tsx";
import { Spinner } from "./Spinner.tsx";

interface Props {
	item: SkillPickerItem;
	onLoad: (
		item: SkillPickerItem,
		signal: AbortSignal,
		target?: SkillInstallTarget,
	) => Promise<void> | void;
	onUnload: (item: SkillPickerItem) => Promise<void> | void;
	onRemove: (item: SkillPickerItem) => Promise<void> | void;
	onCancel: () => void;
}

type ActionId = "load" | "unload" | "remove";

export interface SkillDownloadTarget {
	id: SkillInstallTarget;
	label: string;
}

export const SKILL_DOWNLOAD_TARGETS: readonly SkillDownloadTarget[] = [
	{ id: "repo", label: "Project" },
	{ id: "personal", label: "Personal" },
];

export interface SkillAction {
	id: ActionId;
	label: string;
	enabled: boolean;
	disabledReason?: string;
}

export function skillActions(item: SkillPickerItem): SkillAction[] {
	if (item.source === "skills-sh") {
		return item.active
			? [{ id: "unload", label: "Unload Skill", enabled: true }]
			: [];
	}
	return [
		item.active
			? { id: "unload", label: "Unload Skill", enabled: true }
			: { id: "load", label: "Load Skill", enabled: true },
		{ id: "remove", label: "Remove Skill", enabled: true },
	];
}

export function SkillActions({
	item,
	onLoad,
	onUnload,
	onRemove,
	onCancel,
}: Props): React.ReactElement {
	const choosingTarget = item.source === "skills-sh" && !item.active;
	const submit = useAsyncAction();
	const [abortable, setAbortable] = useState(false);
	const actions = skillActions(item);
	const entryCount = choosingTarget
		? SKILL_DOWNLOAD_TARGETS.length
		: actions.length;
	const selection = useListSelection(entryCount, { digitJump: true });
	const safeSelectedIndex = Math.min(
		selection.index,
		Math.max(0, actions.length - 1),
	);

	const runAction = (
		label: string,
		canAbort: boolean,
		action: (signal: AbortSignal) => Promise<void> | void,
	): void => {
		setAbortable(canAbort);
		submit.run(label, (signal) => Promise.resolve(action(signal)));
	};

	const runSelectedAction = (): void => {
		const action = actions[safeSelectedIndex];
		if (!action) return;
		if (!action.enabled) {
			submit.setError(
				action.disabledReason ?? `${action.label} is unavailable.`,
			);
			return;
		}
		if (action.id === "load") {
			runAction("Loading skill", true, (signal) => onLoad(item, signal));
			return;
		}
		if (action.id === "unload") {
			runAction("Unloading skill", false, () => onUnload(item));
			return;
		}
		runAction("Removing skill", false, () => onRemove(item));
	};

	const runSelectedTarget = (): void => {
		const target =
			SKILL_DOWNLOAD_TARGETS[
				Math.min(selection.index, SKILL_DOWNLOAD_TARGETS.length - 1)
			];
		if (!target) return;
		runAction("Downloading skill", true, (signal) =>
			onLoad(item, signal, target.id),
		);
	};

	useInput((input, key) => {
		if (submit.running) {
			if (key.escape && abortable) submit.cancel();
			return;
		}
		if (key.escape) {
			onCancel();
			return;
		}
		if (selection.onInput(input, key)) {
			submit.setError(null);
			return;
		}
		if (key.return) {
			if (choosingTarget) runSelectedTarget();
			else runSelectedAction();
		}
	});

	return (
		<Panel>
			<Text color={theme.text} bold>
				Skill: {item.name}
			</Text>
			<Text>
				<Text color={theme.subtle}>status </Text>
				<Text color={item.active ? theme.success : theme.subtle}>
					{item.active ? "loaded" : "unloaded"}
				</Text>
				{item.installs ? (
					<Text color={theme.subtle}> · {item.installs} installs</Text>
				) : null}
			</Text>
			{item.description ? (
				<Text color={theme.subtle}>{item.description}</Text>
			) : null}
			{item.detail ? <Text color={theme.subtle}>{item.detail}</Text> : null}
			<Box flexDirection="column" marginTop={1}>
				{choosingTarget ? (
					<>
						<Text color={theme.subtle}>Download to</Text>
						{SKILL_DOWNLOAD_TARGETS.map((target, index) => {
							const selected =
								index ===
								Math.min(selection.index, SKILL_DOWNLOAD_TARGETS.length - 1);
							return (
								<SelectRow key={target.id} selected={selected}>
									<Text
										color={selected ? theme.accentBright : theme.subtle}
										bold={selected}
									>
										{target.label}
									</Text>
								</SelectRow>
							);
						})}
					</>
				) : (
					actions.map((action, index) => {
						const selected = index === safeSelectedIndex;
						const color = action.enabled
							? selected
								? theme.accentBright
								: theme.subtle
							: theme.subtle;
						return (
							<Box key={action.id}>
								<SelectCaret selected={selected} color={color} />
								<Text color={color} bold={selected && action.enabled}>
									{action.label}
								</Text>
							</Box>
						);
					})
				)}
			</Box>
			<ErrorLine error={submit.error} />
			{submit.running ? (
				abortable ? (
					<Text color={theme.subtle}>Esc cancel action</Text>
				) : null
			) : (
				<HintFooter
					marginTop={0}
					hints={[
						"↑/↓ choose",
						entryCount > 1 && `1-${entryCount} jump`,
						"Enter select",
						"Esc back",
					]}
				/>
			)}
			{submit.running ? (
				<Spinner label={submit.label ?? "Updating skill"} />
			) : null}
		</Panel>
	);
}
