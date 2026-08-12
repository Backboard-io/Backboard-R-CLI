#!/usr/bin/env bun
/**
 * Live evaluation harness for the Agent tool. Runs a few real coding-style
 * tasks against Backboard so the worker and rlm modes can be sanity-checked
 * end to end.
 *
 * Requires BACKBOARD_API_KEY (and optionally BACKBOARD_API_URL) in the
 * environment or .env. It is opt-in and never part of `bun test`.
 *
 *   bun run scripts/agent-eval.ts
 */
import { Config } from "../src/config/Config.ts";
import { EventBus } from "../src/core/bus/EventBus.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type { AgentTool } from "../src/tools/AgentTool.tsx";
import { createDefaultTools } from "../src/tools/index.ts";
import { truncate } from "../src/utils/string.ts";

interface EvalCase {
	name: string;
	check: (report: string) => boolean;
	input: Parameters<AgentTool["execute"]>[0];
}

const LARGE_CONTEXT = buildHaystack(4000, 1234, "ANSWER-IS-PINEAPPLE");

const CASES: EvalCase[] = [
	{
		name: "worker: read-only repo investigation",
		input: {
			prompt:
				"Identify the entrypoint file of this CLI and name the function that starts it.\n\nOne line: <file path> - <function name>",
		},
		check: (r) => r.toLowerCase().includes("cli.tsx"),
	},
	{
		name: "rlm: needle in a large context",
		input: {
			prompt: `${LARGE_CONTEXT}\n\nThere is exactly one line containing a secret token of the form ANSWER-IS-XXXX. Return that token.`,
			subagent_type: "rlm",
		},
		check: (r) => r.includes("ANSWER-IS-PINEAPPLE"),
	},
];

async function main(): Promise<void> {
	const config = new Config({ argv: [] });
	const client = new BackboardClient(config.env);
	const tools = createDefaultTools({ client, config });
	const agent = tools.find((t) => t.name === "Agent") as AgentTool | undefined;
	if (!agent) throw new Error("Agent tool was not registered.");

	const ctx: ToolContext = {
		sessionId: "agent-eval",
		cwd: process.cwd(),
		bus: new EventBus(),
		signal: new AbortController().signal,
		askUser: async () => "",
		agentDepth: 0,
	};

	let failures = 0;
	for (const testCase of CASES) {
		process.stdout.write(`\n=== ${testCase.name} ===\n`);
		const started = Date.now();
		try {
			const result = await agent.execute(testCase.input, ctx);
			const passed = testCase.check(result.forLLM);
			if (!passed) failures++;
			process.stdout.write(
				`${passed ? "PASS" : "FAIL"} (${Date.now() - started}ms)\n`,
			);
			process.stdout.write(`report: ${truncate(result.forLLM, 600)}\n`);
		} catch (err) {
			failures++;
			process.stdout.write(
				`ERROR: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	process.stdout.write(
		`\n${CASES.length - failures}/${CASES.length} cases passed.\n`,
	);
	process.exitCode = failures === 0 ? 0 : 1;
}

function buildHaystack(
	lines: number,
	needleLine: number,
	token: string,
): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(
			i === needleLine
				? `line ${i}: the secret token is ${token} keep it safe`
				: `line ${i}: filler entry ${(i * 7919) % 100003} lorem ipsum dolor sit amet`,
		);
	}
	return out.join("\n");
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
