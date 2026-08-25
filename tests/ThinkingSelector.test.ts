import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "../src/providers/backboard/types.ts";
import {
	modelUsesAutomaticThinkingOnly,
	thinkingChoicesForModel,
} from "../src/ui/components/ThinkingSelector.tsx";

function model(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "openai/gpt-5.5",
		provider: "openai",
		model: "gpt-5.5",
		label: "openai/gpt-5.5",
		...overrides,
	};
}

describe("ThinkingSelector choices", () => {
	it("shows only Off for unsupported models", () => {
		expect(
			thinkingChoicesForModel(model({ supports_thinking: false })).map(
				(choice) => choice.label,
			),
		).toEqual(["Off"]);
	});

	it("keeps level choices for models with controls", () => {
		expect(
			thinkingChoicesForModel(model()).map((choice) => choice.label),
		).toEqual(["Off", "Low", "Medium", "High", "Max"]);
	});

	it("identifies defaults-only models for automatic selection outside the picker", () => {
		expect(
			modelUsesAutomaticThinkingOnly(
				model({
					thinking_controls: {
						supported: false,
						allowed_fields: [],
						defaults_only: true,
					},
				}),
			),
		).toBe(true);
	});
});
