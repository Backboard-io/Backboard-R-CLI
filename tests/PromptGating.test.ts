import { describe, expect, it } from "bun:test";
import { Config } from "../src/config/Config.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";
import { TODO_NOT_CALLED_REMINDER } from "../src/prompts/todoReminders.ts";
import { getToolPrompt } from "../src/prompts/tools/index.tsx";
import { createDefaultTools } from "../src/tools/index.ts";
import { TEST_BACKBOARD_ENV } from "./helpers/agent.ts";

function activeToolNames(config: Config): string[] {
	return new ToolRegistry(createDefaultTools())
		.toJSONSchemas(config.enabledTools, config.toolSchemaExcludedNames)
		.map((tool) => tool.function.name);
}

describe("prompt tool gating", () => {
	it("does not mention Write/Edit in OpenAI-gated prompts", () => {
		const config = new Config({ env: TEST_BACKBOARD_ENV, argv: [] });
		const names = activeToolNames(config);
		const systemPrompt = getSystemPrompt({ enabledTools: names });
		const executePrompt = getToolPrompt("Execute", { enabledTools: names });
		const applyPatchPrompt = getToolPrompt("ApplyPatch", {
			enabledTools: names,
		});

		expect(names).toContain("apply_patch");
		expect(names).not.toContain("write");
		expect(names).not.toContain("edit");
		for (const prompt of [systemPrompt, executePrompt, applyPatchPrompt]) {
			expect(prompt).not.toContain("Write/Edit");
			expect(prompt).not.toContain("Use Write");
			expect(prompt).not.toContain("Use Edit");
			expect(prompt).not.toContain("Write tool");
			expect(prompt).not.toContain("Edit tool");
		}
	});

	it("does not mention ApplyPatch in non-OpenAI-gated prompts", () => {
		const config = new Config({
			env: TEST_BACKBOARD_ENV,
			argv: ["--model", "anthropic/claude"],
		});
		const names = activeToolNames(config);
		const systemPrompt = getSystemPrompt({ enabledTools: names });
		const executePrompt = getToolPrompt("Execute", { enabledTools: names });

		expect(names).toContain("write");
		expect(names).toContain("edit");
		expect(names).not.toContain("apply_patch");
		expect(systemPrompt).not.toContain("apply_patch");
		expect(executePrompt).not.toContain("apply_patch");
	});

	it("gates optional companion tools from system and tool prompts", () => {
		const names = ["FetchUrl"];
		expect(getSystemPrompt({ enabledTools: [] })).not.toContain("FetchUrl");
		expect(getToolPrompt("FetchUrl", { enabledTools: names })).not.toContain(
			"WebSearch",
		);
	});

	it("uses autonomous fallback only when AskUser is unavailable", () => {
		expect(getSystemPrompt({ enabledTools: ["AskUser"] })).toContain(
			"Use the ask_user tool for all clarification questions",
		);
		expect(getSystemPrompt({ enabledTools: ["AskUser"] })).not.toContain(
			"No user is available to answer questions",
		);
		expect(getSystemPrompt({ enabledTools: [] })).toContain(
			"No user is available to answer questions",
		);
	});

	it("documents the active Execute shell", () => {
		const bashPrompt = getToolPrompt("Execute", {
			enabledTools: ["Execute"],
			commandShellKind: "bash",
			commandShellPath: "/bin/bash",
		});
		const posixPrompt = getToolPrompt("Execute", {
			enabledTools: ["Execute"],
			commandShellKind: "posix",
			commandShellPath: "/bin/sh",
		});

		expect(bashPrompt).toContain("Shell: commands run under bash (/bin/bash)");
		expect(bashPrompt).toContain("Exit code 124 means execute timed out");
		expect(bashPrompt).toContain("Do not use `sleep` as a polling mechanism");
		expect(bashPrompt).toContain("fireAndForget");
		expect(posixPrompt).toContain("Commands run under POSIX `sh`");
	});

	it("documents TodoWrite object-array inputs", () => {
		const prompt = getToolPrompt("TodoWrite", { enabledTools: ["TodoWrite"] });

		expect(prompt).toContain("Pass `todos` as an array of objects");
		expect(prompt).toContain("Do not pass numbered strings");
		expect(prompt).not.toContain("numbered multi-line string");
	});

	it("includes the todo reminder segment only when provided", () => {
		expect(
			getSystemPrompt({ todoReminderPrompt: TODO_NOT_CALLED_REMINDER }),
		).toContain("TodoWrite was not called yet");
		expect(
			getSystemPrompt({
				profile: "anthropic",
				todoReminderPrompt: TODO_NOT_CALLED_REMINDER,
			}),
		).toContain("TodoWrite was not called yet");
		expect(
			getSystemPrompt({
				profile: "openai",
				todoReminderPrompt: TODO_NOT_CALLED_REMINDER,
			}),
		).toContain("TodoWrite was not called yet");
		expect(getSystemPrompt({})).not.toContain("TodoWrite was not called yet");
	});
});
