import type React from "react";
import {
	modelUsesAutomaticThinkingOnly,
	type ThinkingChoice,
	thinkingChoicesForModel,
} from "../../config/thinkingChoices.ts";
import type { ModelInfo } from "../../providers/backboard/types.ts";
import { Picker, type PickerTab } from "./Picker.tsx";

export {
	modelUsesAutomaticThinkingOnly,
	type ThinkingChoice,
	thinkingChoicesForModel,
};

interface Props {
	model: ModelInfo;
	onSelect: (choice: ThinkingChoice) => void;
	onCancel: () => void;
}

export function ThinkingSelector({
	model,
	onSelect,
	onCancel,
}: Props): React.ReactElement {
	return (
		<Picker
			title="Select Thinking"
			tabs={thinkingTabs(model)}
			onSelect={onSelect}
			onCancel={onCancel}
			emptyLabel="No thinking options."
			showSearch={false}
		/>
	);
}

function thinkingTabs(model: ModelInfo): PickerTab<ThinkingChoice>[] {
	const choices = thinkingChoicesForModel(model);
	return [
		{
			id: "thinking",
			label: "Thinking",
			items: choices.map((choice) => ({
				id: choice.label.toLowerCase(),
				name: choice.label,
				value: choice,
			})),
		},
	];
}
