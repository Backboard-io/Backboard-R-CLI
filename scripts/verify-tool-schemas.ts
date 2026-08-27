#!/usr/bin/env bun
/**
 * Sends one tiny request with every built-in tool schema attached (computer
 * and browser enabled) to each configured backend: every BYOK provider you
 * hold a key for, and every LLM provider Backboard offers through your login.
 * Catches schema rejections such as xAI's "exclusiveMinimum: true is not of
 * type number" before a user does.
 *
 *   bun run scripts/verify-tool-schemas.ts            # everything
 *   bun run scripts/verify-tool-schemas.ts -f grok    # model name filter
 *
 * Opt-in; never part of `bun test`. Costs a few tokens per model.
 */
import { Config } from "../src/config/Config.ts";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { BackboardClient } from "../src/providers/backboard/BackboardClient.ts";
import type { ModelCatalogItem } from "../src/providers/backboard/types.ts";
import { byokAdapter } from "../src/providers/byok/registry.ts";
import { createAgentClient } from "../src/providers/createAgentClient.ts";
import { createDefaultTools } from "../src/tools/index.ts";

const filterIndex = process.argv.indexOf("-f");
const filter = filterIndex >= 0 ? process.argv[filterIndex + 1] : undefined;
if (filterIndex >= 0 && (!filter || filter.startsWith("-"))) {
	throw new Error("-f requires a provider/model filter");
}

const config = new Config({ argv: [] });
config.enableComputerUse();
config.enableBrowserUse();
const router = createAgentClient(config);
await Promise.all(
	config.auth.providerKeys.map(async ({ provider, key }) => {
		try {
			await byokAdapter(provider).listModels(key);
		} catch (err) {
			throw new Error(
				`${provider} catalog failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}),
);
let toolList: ReturnType<typeof createDefaultTools> = [];
toolList = createDefaultTools({
	client: router,
	config,
	getTools: () => toolList,
});
const tools = new ToolRegistry(toolList).toJSONSchemas(
	config.enabledTools,
	config.toolSchemaExcludedNames,
);
const backboard = config.hasBackboardAuth
	? new BackboardClient(config.env)
	: null;
if (backboard) await backboard.listModels();
const catalog = (await router.listModels()).models;

/** Models that are not chat endpoints or are only reachable through batch APIs. */
const SKIP = /:batch$|speechmatics|whisper|tts|embed|voxtral|rerank/i;
const PREFERRED = [
	/gpt-5\.5$/,
	/claude-sonnet-5$/,
	/gemini-3\.5-flash$/,
	/grok-4\.6$/,
	/kimi-k3$/,
	/gpt-oss-120b$/,
	/command-a/,
];

function pick(models: ModelCatalogItem[]): string | undefined {
	const names = models.map((m) => m.name).filter((n) => !SKIP.test(n));
	for (const re of PREFERRED) {
		const hit = names.find((n) => re.test(n));
		if (hit) return hit;
	}
	return names[0];
}

let pass = 0;
let total = 0;
async function probe(
	source: string,
	client: { runMessage: BackboardClient["runMessage"] },
	provider: string,
	model: string,
): Promise<void> {
	if (filter && !`${provider}/${model}`.includes(filter)) return;
	total++;
	const started = performance.now();
	let detail = "";
	let ok = false;
	let text = "";
	try {
		for await (const event of client.runMessage(
			{
				content: "Reply with the single word OK.",
				llm_provider: provider,
				model_name: model,
				system_prompt: "You are a terse assistant.",
				tools,
				memory: "off",
			},
			{ signal: AbortSignal.timeout(90_000) },
		)) {
			if (event.kind === "failed") {
				detail = event.error;
				break;
			}
			if (event.kind === "assistant_delta") text += event.text;
			if (event.kind === "completed") ok = true;
			if (event.kind === "requires_action") {
				ok = true;
				detail = "tool call";
				break;
			}
		}
		if (ok && !detail) detail = JSON.stringify(text.trim().slice(0, 30));
	} catch (err) {
		detail = err instanceof Error ? err.message : String(err);
	}
	if (ok) pass++;
	process.stdout.write(
		`${ok ? "PASS" : "FAIL"}  ${source.padEnd(9)} ${provider.padEnd(12)} ${model.padEnd(40)} ${String(Math.round(performance.now() - started)).padStart(5)}ms  ${detail.slice(0, 140)}\n`,
	);
}

process.stdout.write(
	`tools (${tools.length}): ${tools.map((t) => t.function.name).join(",")}\n\n`,
);

// BYOK: one model per provider you hold a key for, plus the major vendors via OpenRouter.
const byok = catalog.filter((m) => m.source === "byok");
for (const provider of [...new Set(byok.map((m) => m.provider))]) {
	if (provider === "openrouter") {
		for (const vendor of [
			"x-ai/",
			"openai/",
			"google/",
			"anthropic/",
			"moonshotai/",
			"deepseek/",
			"qwen/",
			"meta-llama/",
			"z-ai/",
		]) {
			const model = pick(
				byok.filter(
					(m) => m.provider === "openrouter" && m.name.startsWith(vendor),
				),
			);
			if (model) await probe("byok", router, "openrouter", model);
		}
		continue;
	}
	const model = pick(byok.filter((m) => m.provider === provider));
	if (model) await probe("byok", router, provider, model);
}

// Backboard: one model per provider the server offers through your login.
if (backboard) {
	const server = catalog.filter((m) => m.source !== "byok");
	const providers = new Set(server.map((m) => m.provider));
	// The merged catalog hides Backboard's own route for providers you also hold a key for.
	for (const provider of [...new Set(byok.map((m) => m.provider))])
		providers.add(provider);
	for (const provider of providers) {
		if (SKIP.test(provider)) continue;
		const model =
			pick(server.filter((m) => m.provider === provider)) ??
			pick(
				byok.filter((m) => m.provider === provider && !m.name.includes("/")),
			);
		if (model) await probe("backboard", backboard, provider, model);
	}
}

process.stdout.write(`\n${pass}/${total} passed\n`);
if (filter && total === 0) {
	process.stderr.write(`No provider/model matched filter: ${filter}\n`);
	process.exit(1);
}
process.exit(pass === total ? 0 : 1);
