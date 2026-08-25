import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackboardConfigFile } from "../src/config/BackboardConfigTypes.ts";
import {
	readBackboardConfig,
	saveBackboardConfig,
} from "../src/config/backboardConfig.ts";
import { Config } from "../src/config/Config.ts";
import { EXPERT_EXECUTION_TOOLS } from "../src/core/tools/ToolPolicy.ts";

const env = { apiKey: "test-key", apiUrl: "https://example.test/api" };
const OPUS = { provider: "anthropic", model: "claude-opus-4.8" };
const KIMI = { provider: "moonshot", model: "kimi-k3" };

async function configWith(file: BackboardConfigFile): Promise<Config> {
	const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
	await saveBackboardConfig({ model: OPUS, ...file }, homeDir);
	return new Config({ env, argv: [], homeDir });
}

describe("expert mode selection", () => {
	it("is off by default and executes on the main model", async () => {
		const config = await configWith({});
		expect(config.isExpertModeEnabled).toBe(false);
		expect(config.expertModel).toBeNull();
		expect(config.executionModel).toEqual(OPUS);
	});

	it("loads a persisted expert selection", async () => {
		const config = await configWith({
			expert: {
				enabled: true,
				model: KIMI,
				thinking: { kind: "level", level: "high" },
			},
		});
		expect(config.isExpertModeEnabled).toBe(true);
		expect(config.expertModel).toEqual(KIMI);
		expect(config.executionThinking).toEqual({ kind: "level", level: "high" });
	});

	it("splits planning and execution across the two models", async () => {
		const config = await configWith({
			expert: { enabled: true, model: KIMI },
		});
		expect(config.model).toEqual(OPUS);
		expect(config.executionModel).toEqual(KIMI);
	});

	it("stays off when enabled without a model", async () => {
		const config = await configWith({ expert: { enabled: true } });
		expect(config.isExpertModeEnabled).toBe(false);
		expect(config.executionModel).toEqual(OPUS);
	});

	it("falls back to the main thinking intent when expert mode is off", async () => {
		const config = await configWith({
			thinking: { kind: "level", level: "low" },
			expert: { enabled: false, model: KIMI },
		});
		expect(config.executionThinking).toEqual({ kind: "level", level: "low" });
	});

	it("persists a selection made at runtime", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
		await saveBackboardConfig({ model: OPUS }, homeDir);
		const config = new Config({ env, argv: [], homeDir });

		config.setExpertMode({
			enabled: true,
			model: KIMI,
			thinking: { kind: "dynamic" },
		});
		await config.saveExpertPreference();

		expect(readBackboardConfig(homeDir).expert).toEqual({
			enabled: true,
			model: KIMI,
			thinking: { kind: "dynamic" },
		});
		// The main /model selection is untouched by an expert change.
		expect(readBackboardConfig(homeDir).model).toEqual(OPUS);
	});

	it("keeps concurrent preference saves from clobbering each other", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
		await saveBackboardConfig({ model: OPUS }, homeDir);
		const config = new Config({ env, argv: [], homeDir });

		config.setExpertMode({
			enabled: true,
			model: KIMI,
			thinking: { kind: "dynamic" },
		});
		config.setVerbose(true);
		await Promise.all([
			config.saveExpertPreference(),
			config.saveVerbosePreference(),
		]);

		const saved = readBackboardConfig(homeDir);
		expect(saved.expert?.enabled).toBe(true);
		expect(saved.verbose).toBe(true);
	});

	it("keeps the remembered model when expert mode is switched off", async () => {
		const config = await configWith({
			expert: { enabled: true, model: KIMI },
		});
		config.setExpertMode({ enabled: false });
		expect(config.isExpertModeEnabled).toBe(false);
		expect(config.expertModel).toEqual(KIMI);
		expect(config.executionModel).toEqual(OPUS);
	});
});

describe("expert mode tool policy", () => {
	it("hides the implementation tools from the main model", async () => {
		const config = await configWith({
			expert: { enabled: true, model: KIMI },
		});
		for (const name of EXPERT_EXECUTION_TOOLS) {
			expect(config.isToolEnabled(name)).toBe(false);
			expect(config.toolSchemaExcludedNames).toContain(name);
		}
	});

	it("keeps the agent tool so the main model can still delegate", async () => {
		const config = await configWith({
			expert: { enabled: true, model: KIMI },
		});
		expect(config.isToolEnabled("agent")).toBe(true);
		expect(config.isToolEnabled("read")).toBe(true);
		expect(config.isToolEnabled("grep")).toBe(true);
	});

	it("leaves the implementation tools with the sub-agent", async () => {
		const on = await configWith({ expert: { enabled: true, model: KIMI } });
		expect(on.isDelegatedToolEnabled("edit")).toBe(true);
		expect(on.isDelegatedToolEnabled("write")).toBe(true);
		expect(on.isDelegatedToolEnabled("execute")).toBe(true);
	});

	it("gives the sub-agent the tools the expert model's profile wants", async () => {
		// The planner is an OpenAI model, whose profile swaps edit/write for
		// apply_patch. The executor is not, so it must get edit/write instead.
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
		await saveBackboardConfig(
			{ model: { provider: "openai", model: "gpt-5" } },
			homeDir,
		);
		const config = new Config({ env, argv: [], homeDir });
		config.setExpertMode({ enabled: true, model: KIMI });

		expect(config.modelProfile.name).toBe("openai");
		expect(config.executionModelProfile.name).toBe("default");
		expect(config.isDelegatedToolEnabled("edit")).toBe(true);
		expect(config.isDelegatedToolEnabled("write")).toBe(true);
		expect(config.isDelegatedToolEnabled("apply_patch")).toBe(false);
	});

	it("hands the sub-agent the planner's profile when expert mode is off", async () => {
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
		await saveBackboardConfig(
			{ model: { provider: "openai", model: "gpt-5" } },
			homeDir,
		);
		const config = new Config({ env, argv: [], homeDir });

		expect(config.executionModelProfile.name).toBe("openai");
		expect(config.isDelegatedToolEnabled("edit")).toBe(false);
		expect(config.isDelegatedToolEnabled("apply_patch")).toBe(true);
	});

	it("resolves a custom agent's tools from the model it pins", async () => {
		// The session is OpenAI, whose profile swaps edit/write for apply_patch.
		// An agent that pins a Moonshot model sends its turns there, so it must
		// get that model's tools rather than the session's.
		const homeDir = await mkdtemp(path.join(os.tmpdir(), "cli-expert-"));
		await saveBackboardConfig(
			{ model: { provider: "openai", model: "gpt-5" } },
			homeDir,
		);
		const config = new Config({ env, argv: [], homeDir });

		expect(config.isDelegatedToolEnabled("apply_patch")).toBe(true);
		expect(config.isDelegatedToolEnabled("apply_patch", KIMI)).toBe(false);
		expect(config.isDelegatedToolEnabled("edit", KIMI)).toBe(true);
		expect(config.delegatedToolPolicyFor(KIMI).isRuntimeAllowed("write")).toBe(
			true,
		);
	});

	it("only withholds what expert mode named", async () => {
		const on = await configWith({ expert: { enabled: true, model: KIMI } });
		const off = await configWith({ expert: { enabled: false, model: KIMI } });
		const alreadyExcluded = new Set(off.toolPolicy.schemaExcludedNames());
		const added = on.toolPolicy
			.schemaExcludedNames()
			.filter((name) => !alreadyExcluded.has(name));
		expect(added.sort()).toEqual(
			EXPERT_EXECUTION_TOOLS.filter(
				(name) => !alreadyExcluded.has(name),
			).sort(),
		);
	});

	it("restores the implementation tools when expert mode is off", async () => {
		const config = await configWith({
			expert: { enabled: false, model: KIMI },
		});
		expect(config.isToolEnabled("edit")).toBe(true);
		expect(config.isToolEnabled("write")).toBe(true);
		expect(config.isToolEnabled("execute")).toBe(true);
	});

	it("takes effect as soon as the toggle flips", async () => {
		const config = await configWith({});
		expect(config.isToolEnabled("edit")).toBe(true);
		config.setExpertMode({ enabled: true, model: KIMI });
		expect(config.isToolEnabled("edit")).toBe(false);
		config.setExpertMode({ enabled: false });
		expect(config.isToolEnabled("edit")).toBe(true);
	});
});
