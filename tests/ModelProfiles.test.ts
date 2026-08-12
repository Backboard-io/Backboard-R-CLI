import { describe, expect, it } from "bun:test";
import {
	combineToolAllowlists,
	combineToolExclusions,
	getModelProfile,
	resolveModelProfile,
} from "../src/config/modelProfiles/index.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";

describe("model profiles", () => {
	it("matches model profiles from provider/model strings", () => {
		expect(
			resolveModelProfile({ provider: "openai", model: "gpt-5.5" }).name,
		).toBe("openai");
		expect(
			resolveModelProfile({
				provider: "anthropic",
				model: "claude-sonnet-4.5",
			}).name,
		).toBe("anthropic");
		expect(
			resolveModelProfile({ provider: "openrouter", model: "z-ai/glm-5.2" })
				.name,
		).toBe("glm");
	});

	it("finds model profiles by partial profile names", () => {
		expect(getModelProfile("open")?.name).toBe("openai");
		expect(getModelProfile("anth")?.name).toBe("anthropic");
		expect(getModelProfile("missing")).toBeUndefined();
	});

	it("combines model profile and base profile tool allowlists", () => {
		expect(combineToolAllowlists([], [])).toEqual([]);
		expect(combineToolAllowlists([], ["Read", "Grep"])).toEqual([
			"read",
			"grep",
		]);
		expect(
			combineToolAllowlists(["Read", "Edit", "Execute"], ["Read", "Grep"]),
		).toEqual(["read"]);
	});

	it("combines tool exclusions", () => {
		expect(combineToolExclusions(["Write"], ["Edit", "Write"])).toEqual([
			"write",
			"edit",
		]);
	});

	it("configures model profile edit surfaces", () => {
		expect(
			resolveModelProfile({ provider: "openai", model: "gpt-5.5" })
				.excludedTools,
		).toEqual(["Write", "Edit"]);
		expect(
			resolveModelProfile({ provider: "anthropic", model: "claude" })
				.excludedTools,
		).toEqual(["ApplyPatch"]);
		expect(
			resolveModelProfile({ provider: "openrouter", model: "z-ai/glm" })
				.excludedTools,
		).toEqual(["ApplyPatch"]);
	});

	it("keeps model profile prompts identical until variants are configured", () => {
		const defaultPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "openrouter",
				model: "z-ai/glm-5.2",
			}).systemPromptLayout,
		});
		const openaiPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "openai",
				model: "gpt-5.5",
			}).systemPromptLayout,
		});
		const antPrompt = getSystemPrompt({
			layout: resolveModelProfile({
				provider: "anthropic",
				model: "claude-sonnet-4.5",
			}).systemPromptLayout,
		});

		expect(openaiPrompt).toBe(defaultPrompt);
		expect(antPrompt).toBe(defaultPrompt);
		expect(openaiPrompt).toContain("You are R-CLI");
	});
});
