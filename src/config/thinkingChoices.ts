import type { ModelInfo } from "../providers/backboard/types.ts";
import type { ThinkingIntent } from "./defaults.ts";
import { resolveThinkingCapabilities } from "./thinkingCapabilities.ts";

export interface ThinkingChoice {
	label: string;
	value: ThinkingIntent | null | undefined;
}

export interface ThinkingChoiceMetadata {
	choices: ThinkingChoice[];
	automaticOnly: boolean;
	selectable: boolean;
}

const OFF_CHOICE: ThinkingChoice = { label: "Off", value: null };

const LEVEL_CHOICES: ThinkingChoice[] = [
	{ label: "Low", value: { kind: "level", level: "low" } },
	{ label: "Medium", value: { kind: "level", level: "medium" } },
	{ label: "High", value: { kind: "level", level: "high" } },
	{ label: "Max", value: { kind: "level", level: "max" } },
];

export function buildThinkingChoiceMetadata(
	model: ModelInfo,
): ThinkingChoiceMetadata {
	const capabilities = resolveThinkingCapabilities({ model, metadata: model });
	if (!capabilities.supportsThinking) {
		return { choices: [OFF_CHOICE], automaticOnly: false, selectable: false };
	}

	if (capabilities.defaultsOnly) {
		return {
			choices: [{ label: "Automatic", value: undefined }],
			automaticOnly: true,
			selectable: false,
		};
	}

	if (capabilities.allowedFields.length === 0) {
		return { choices: [OFF_CHOICE], automaticOnly: false, selectable: false };
	}

	return {
		choices: [OFF_CHOICE, ...LEVEL_CHOICES],
		automaticOnly: false,
		selectable: true,
	};
}

export function thinkingChoicesForModel(model: ModelInfo): ThinkingChoice[] {
	return buildThinkingChoiceMetadata(model).choices;
}

export function modelUsesAutomaticThinkingOnly(model: ModelInfo): boolean {
	return buildThinkingChoiceMetadata(model).automaticOnly;
}
