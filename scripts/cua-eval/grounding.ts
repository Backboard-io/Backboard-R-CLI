#!/usr/bin/env bun
/**
 * Tier-0 grounding eval: replays saved screenshots through the real agent
 * loop and scores whether its first click lands inside the expected bounds.
 * No sandbox, no side effects — only model tokens.
 *
 *   bun run scripts/cua-eval/grounding.ts            # all fixtures
 *   bun run scripts/cua-eval/grounding.ts -f calc-   # name prefix
 *   bun run scripts/cua-eval/grounding.ts --coords   # hide targets → coordinate grounding
 *
 * Needs BACKBOARD_API_KEY (also read from ../cli-eval/.env).
 */
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Config } from "../../src/config/Config.ts";
import {
	createRuntimeThinkingResolver,
	resolveRuntimeThinking,
} from "../../src/config/thinkingRuntime.ts";
import { SubAgentRunner } from "../../src/core/agent/SubAgentRunner.ts";
import { ComputerRuntime } from "../../src/core/computer/ComputerRuntime.ts";
import { emptyRuleSet } from "../../src/core/permissions/PermissionRules.ts";
import type { Tool } from "../../src/core/tools/Tool.ts";
import { computer as computerSystemPrompt } from "../../src/prompts/system/computer.tsx";
import { createAgentClient } from "../../src/providers/createAgentClient.ts";
import { ComputerTool } from "../../src/tools/ComputerTool.tsx";
import { loadEvalEnv } from "./env.ts";
import {
	FixturePlatform,
	loadFixture,
	pointInBounds,
} from "./FixturePlatform.ts";

const argv = process.argv.slice(2);
const filter = argv.includes("-f") ? argv[argv.indexOf("-f") + 1] : undefined;
const coords = argv.includes("--coords");
const dir = resolve(
	argv.includes("--dir")
		? (argv[argv.indexOf("--dir") + 1] ?? "")
		: "tests/fixtures/cua-grounding",
);

loadEvalEnv();
const config = new Config({
	argv: [],
	env: {
		apiKey: process.env.BACKBOARD_API_KEY ?? "",
		apiUrl: process.env.BACKBOARD_API_URL ?? "https://app.backboard.io/api",
	},
});
const client = createAgentClient(config);

const files = (await readdir(dir))
	.filter((f) => f.endsWith(".json") && (!filter || f.startsWith(filter)))
	.sort();
if (files.length === 0) {
	process.stderr.write(`no fixtures in ${dir}\n`);
	process.exit(2);
}
process.stdout.write(
	`${files.length} fixture(s) · ${config.model.provider}/${config.model.model}${coords ? " · coordinate mode" : ""}\n`,
);

let passed = 0;
for (const file of files) {
	const { fixture, imagePath } = await loadFixture(join(dir, file));
	const platform = new FixturePlatform(
		{ ...fixture, hideTarget: coords || fixture.hideTarget },
		imagePath,
	);
	const tool = new ComputerTool(new ComputerRuntime({ platform }));
	const runner = new SubAgentRunner({
		client,
		getModel: () => config.model,
		memory: config.memory,
		memoryProfile: config.memoryProfile,
		getThinking: () => resolveRuntimeThinking(config, client),
		getThinkingResolver: () => createRuntimeThinkingResolver(config, client),
		systemPrompt: `${computerSystemPrompt.prompt}\n\nDo exactly one thing: take a screenshot, then perform the single click the user asks for, then stop and say "done".`,
		toolFactory: () => [tool] as Tool[],
	});
	const started = performance.now();
	let error: string | undefined;
	let tokens = 0;
	try {
		const result = await runner.run({
			prompt: fixture.instruction,
			depth: 1,
			parentCwd: process.cwd(),
			parentSignal: AbortSignal.timeout(120_000),
			parentPermissions: {
				mode: "bypass",
				rules: emptyRuleSet(),
				interactive: false,
			},
		});
		tokens = (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}
	const click = platform.firstClick;
	const ok = click !== null && pointInBounds(click, fixture.expected);
	if (ok) passed++;
	const ms = Math.round(performance.now() - started);
	process.stdout.write(
		`${ok ? "PASS" : "FAIL"}  ${fixture.name.padEnd(24)} ${click ? `(${Math.round(click.x)}, ${Math.round(click.y)})` : "no click"}  expected ${JSON.stringify(fixture.expected)}  ${ms}ms ${tokens}tok${error ? `  ERR ${error}` : ""}\n`,
	);
}
process.stdout.write(`\n${passed}/${files.length} passed\n`);
process.exit(passed === files.length ? 0 : 1);
