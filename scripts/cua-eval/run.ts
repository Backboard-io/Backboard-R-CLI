#!/usr/bin/env bun
/**
 * Tier-1 computer-use eval: runs the real agent loop (SubAgentRunner with the
 * Computer tool) against programmatically checkable tasks in fresh Daytona
 * XFCE sandboxes, then reports success, steps, latency, screenshots, and
 * tokens per task.
 *
 *   bun run scripts/cua-eval/run.ts                # all tasks
 *   bun run scripts/cua-eval/run.ts -f editor-,web- # id prefix filter(s)
 *   bun run scripts/cua-eval/run.ts --dry          # sandbox + platform only, no model
 *   bun run scripts/cua-eval/run.ts --build-snapshot backboard-cua-eval
 *   bun run scripts/cua-eval/run.ts --snapshot backboard-cua-eval -c 4
 *
 * Needs BACKBOARD_API_KEY and DAYTONA_API_KEY (also read from
 * ../Espri-API/cli-eval/.env when present). Never part of `bun test`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Config } from "../../src/config/Config.ts";
import {
	createRuntimeThinkingResolver,
	resolveRuntimeThinking,
} from "../../src/config/thinkingRuntime.ts";
import { SubAgentRunner } from "../../src/core/agent/SubAgentRunner.ts";
import { ComputerRuntime } from "../../src/core/computer/ComputerRuntime.ts";
import type { ComputerQueueResult } from "../../src/core/computer/ComputerTypes.ts";
import { emptyRuleSet } from "../../src/core/permissions/PermissionRules.ts";
import type { Tool } from "../../src/core/tools/Tool.ts";
import type { ToolContext } from "../../src/core/tools/ToolContext.ts";
import type { ToolResult } from "../../src/core/tools/ToolResult.ts";
import { computer as computerSystemPrompt } from "../../src/prompts/system/computer.tsx";
import { createAgentClient } from "../../src/providers/createAgentClient.ts";
import { ComputerTool } from "../../src/tools/ComputerTool.tsx";
import { ExecuteTool } from "../../src/tools/ExecuteTool.tsx";
import { DaytonaPlatform } from "./DaytonaPlatform.ts";
import { loadEvalEnv } from "./env.ts";
import {
	BROWSER_CANDIDATES,
	EVAL_TASKS,
	type EvalTask,
	REQUIRED_PACKAGES,
} from "./tasks.ts";

interface Args {
	filter?: string;
	concurrency: number;
	dry: boolean;
	snapshot?: string;
	buildSnapshot?: string;
	out: string;
	maxRounds: number;
	keep: boolean;
}

interface TaskMetrics {
	id: string;
	group: string;
	pass: boolean;
	detail: string;
	status: string;
	rounds: number;
	computerCalls: number;
	actions: number;
	screenshots: number;
	imageBytes: number;
	actionMs: number;
	settleMs: number;
	observeMs: number;
	wallMs: number;
	inputTokens: number;
	outputTokens: number;
	error?: string;
	report?: string;
	/** Per Computer call: what ran and what the screen looked like afterwards. */
	trace?: Array<{
		actions: string[];
		errors: string[];
		window?: string;
		elements?: number;
		ms: number;
	}>;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		concurrency: 3,
		dry: false,
		out: "scripts/cua-eval/results",
		maxRounds: 20,
		keep: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i];
		switch (arg) {
			case "-f":
			case "--filter":
				args.filter = next();
				break;
			case "-c":
			case "--concurrency":
				args.concurrency = Number(next());
				break;
			case "--dry":
				args.dry = true;
				break;
			case "--snapshot":
				args.snapshot = next();
				break;
			case "--build-snapshot":
				args.buildSnapshot = next();
				break;
			case "--out":
				args.out = next() ?? args.out;
				break;
			case "--max-rounds":
				args.maxRounds = Number(next());
				break;
			case "--keep":
				args.keep = true;
				break;
		}
	}
	return args;
}

/** Records every Computer call so the eval can report cost and latency. */
class MeteredComputerTool extends ComputerTool {
	calls: ComputerQueueResult[] = [];

	override async execute(
		input: Parameters<ComputerTool["execute"]>[0],
		ctx: ToolContext,
	): Promise<ToolResult<ComputerQueueResult>> {
		const result = await super.execute(input, ctx);
		this.calls.push(result.data);
		return result;
	}
}

/** True when `command --version` prints something (not Ubuntu's snap stub). */
async function browserWorks(
	platform: DaytonaPlatform,
	command: string,
): Promise<boolean> {
	const probe = await platform.exec(
		`command -v ${command} >/dev/null 2>&1 || exit 0; grep -q snap "$(command -v ${command})" 2>/dev/null && exit 0; timeout 20 ${command} --version 2>/dev/null | head -n 1`,
		30,
	);
	return probe.output.trim() !== "";
}

/** Launch line for the resolved browser, with the flags containers need. */
function browserLaunch(command: string): string {
	if (/chromium/.test(command)) {
		return `${command} --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --force-renderer-accessibility --new-window`;
	}
	if (/firefox/.test(command)) return `${command} --new-window`;
	return command;
}

/** Installs missing packages; returns the browser command that is available. */
async function installPackages(
	platform: DaytonaPlatform,
	log: (s: string) => void,
): Promise<string> {
	const who = await platform.exec("id -u; command -v sudo || echo nosudo", 10);
	const isRoot = who.output.trim().startsWith("0");
	const sudo = isRoot || who.output.includes("nosudo") ? "" : "sudo -n ";
	const missing: string[] = [];
	let browser = "";
	const needsBrowser = REQUIRED_PACKAGES.includes("browser");
	for (const pkg of REQUIRED_PACKAGES) {
		if (pkg === "browser") continue;
		const probe = await platform.exec(
			`command -v ${pkg} >/dev/null 2>&1 && echo yes || echo no`,
			20,
		);
		if (!probe.output.includes("yes")) missing.push(pkg);
	}
	if (needsBrowser) {
		for (const candidate of BROWSER_CANDIDATES) {
			if (await browserWorks(platform, candidate)) {
				browser = candidate;
				break;
			}
		}
	}
	if (missing.length > 0 || (needsBrowser && !browser)) {
		await platform.exec(
			`${sudo}apt-get update -qq >/tmp/apt.log 2>&1; echo done`,
			300,
		);
	}
	if (needsBrowser && !browser) {
		for (const candidate of BROWSER_CANDIDATES) {
			const policy = await platform.exec(
				`apt-cache policy ${candidate} 2>/dev/null | grep Candidate: || true`,
				30,
			);
			const line = policy.output.trim();
			if (line && !/\(none\)|snap/i.test(line)) {
				missing.push(candidate);
				browser = candidate;
				break;
			}
		}
		if (!browser) throw new Error("no installable browser package found");
	}
	if (missing.length > 0) {
		log(`installing ${missing.join(", ")}`);
		const result = await platform.exec(
			`DEBIAN_FRONTEND=noninteractive ${sudo}apt-get install -y -qq --no-install-recommends ${missing.join(" ")} >>/tmp/apt.log 2>&1; echo exit=$?; tail -n 5 /tmp/apt.log`,
			900,
		);
		if (!result.output.includes("exit=0")) {
			throw new Error(`package install failed: ${result.output.slice(-400)}`);
		}
		if (needsBrowser && !(await browserWorks(platform, browser))) {
			throw new Error(`browser ${browser} installed but does not run`);
		}
	}
	if (browser) platform.setBrowserCommand(browserLaunch(browser));
	return browser ? browserLaunch(browser) : "";
}

async function buildSnapshot(name: string): Promise<void> {
	const log = (s: string) => process.stdout.write(`[snapshot] ${s}\n`);
	const platform = await DaytonaPlatform.create({ log });
	try {
		await installPackages(platform, log);
		log(`creating snapshot ${name}`);
		await platform.sandbox.createSnapshot(name, 600);
		log("done");
	} finally {
		await platform.dispose();
	}
}

async function runTask(
	task: EvalTask,
	args: Args,
	config: Config | null,
): Promise<TaskMetrics> {
	const log = (s: string) => process.stdout.write(`[${task.id}] ${s}\n`);
	const started = performance.now();
	const metrics: TaskMetrics = {
		id: task.id,
		group: task.group,
		pass: false,
		detail: "",
		status: "not-run",
		rounds: 0,
		computerCalls: 0,
		actions: 0,
		screenshots: 0,
		imageBytes: 0,
		actionMs: 0,
		settleMs: 0,
		observeMs: 0,
		wallMs: 0,
		inputTokens: 0,
		outputTokens: 0,
	};
	let platform: DaytonaPlatform | null = null;
	try {
		platform = await DaytonaPlatform.create({
			snapshot: args.snapshot,
			log,
			labels: { "backboard-cua-eval": task.id },
		});
		const browser = await installPackages(platform, log);
		for (const raw of task.setup ?? []) {
			const command = raw.replaceAll("{{browser}}", browser || "chromium");
			const result = await platform.exec(command, 120);
			if (result.exitCode !== 0)
				log(`setup exit ${result.exitCode}: ${result.output.slice(0, 200)}`);
		}
		const computerTool = new MeteredComputerTool(
			new ComputerRuntime({
				platform,
				settleTimeoutMs: 1500,
				openAppSettleTimeoutMs: 4000,
			}),
		);

		if (args.dry) {
			const ctx: ToolContext = {
				sessionId: `cua-eval-${task.id}`,
				cwd: process.cwd(),
				bus: new (await import("../../src/core/bus/EventBus.ts")).EventBus(),
				signal: new AbortController().signal,
				askUser: async () => "",
			};
			const shot = await computerTool.execute(
				{ actions: [{ action: "screenshot" }] },
				ctx,
			);
			const obs = shot.data.observation;
			log(
				`dry: ${obs?.screenSize.width}x${obs?.screenSize.height} → ${obs?.imageSize.width}x${obs?.imageSize.height}, ${obs?.elements.length} elements, window ${JSON.stringify(obs?.windowTitle ?? "")}`,
			);
			metrics.status = "dry";
			metrics.detail = "platform ok";
			metrics.pass = Boolean(obs?.__image_base64);
			return metrics;
		}
		if (!config) throw new Error("config required");

		const client = createAgentClient(config);
		const runner = new SubAgentRunner({
			client,
			getModel: () => config.model,
			memory: config.memory,
			memoryProfile: config.memoryProfile,
			getThinking: () => resolveRuntimeThinking(config, client),
			getThinkingResolver: () => createRuntimeThinkingResolver(config, client),
			systemPrompt: `${computerSystemPrompt.prompt}\n\nYou are operating a Linux XFCE desktop. The Execute tool runs shell commands inside the same machine; use it whenever a command is faster than the GUI. When the task is complete, reply with a one-line summary and stop.`,
			toolFactory: () => [computerTool, new ExecuteTool()] as Tool[],
		});
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
		try {
			const result = await runner.run({
				prompt: task.instruction,
				depth: 1,
				parentCwd: "/home/daytona",
				parentSignal: controller.signal,
				parentPermissions: {
					mode: "bypass",
					rules: emptyRuleSet(),
					interactive: false,
				},
			});
			metrics.status = result.status;
			metrics.rounds = result.toolRounds;
			metrics.report = result.report.slice(0, 400);
			metrics.inputTokens = result.usage.inputTokens ?? 0;
			metrics.outputTokens = result.usage.outputTokens ?? 0;
		} finally {
			clearTimeout(timer);
		}
		metrics.trace = computerTool.calls.map((call) => ({
			actions: call.results.map(
				(r) => `${r.success ? "✓" : r.skipped ? "·" : "✗"} ${r.summary}`,
			),
			errors: call.results.flatMap((r) => (r.error ? [r.error] : [])),
			...(call.observation?.windowTitle
				? { window: call.observation.windowTitle }
				: {}),
			...(call.observation
				? { elements: call.observation.elements.length }
				: {}),
			ms: call.timing.totalMs,
		}));
		for (const call of computerTool.calls) {
			metrics.computerCalls++;
			metrics.actions += call.results.length;
			if (call.observation) {
				metrics.screenshots++;
				metrics.imageBytes += Math.round(
					(call.observation.__image_base64?.length ?? 0) * 0.75,
				);
			}
			metrics.actionMs += call.timing.actionsMs;
			metrics.settleMs += call.timing.settleMs;
			metrics.observeMs += call.timing.observeMs;
		}
		const check = await task.check(platform);
		metrics.pass = check.pass;
		metrics.detail = check.detail;
		log(`${check.pass ? "PASS" : "FAIL"} — ${check.detail}`);
	} catch (err) {
		metrics.error = err instanceof Error ? err.message : String(err);
		metrics.detail = metrics.error;
		log(`ERROR ${metrics.error}`);
	} finally {
		metrics.wallMs = Math.round(performance.now() - started);
		if (platform && !args.keep) await platform.dispose();
		else if (platform)
			log(
				`kept sandbox ${platform.sandbox.id} (${await platform.previewUrl()})`,
			);
	}
	return metrics;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	loadEvalEnv();
	if (!process.env.DAYTONA_API_KEY)
		throw new Error("DAYTONA_API_KEY is not set");
	if (args.buildSnapshot) {
		await buildSnapshot(args.buildSnapshot);
		return;
	}
	const config = args.dry
		? null
		: new Config({
				argv: [],
				env: {
					apiKey: process.env.BACKBOARD_API_KEY ?? "",
					apiUrl:
						process.env.BACKBOARD_API_URL ?? "https://app.backboard.io/api",
				},
			});
	const filters = (args.filter ?? "")
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean);
	const tasks = EVAL_TASKS.filter(
		(task) =>
			filters.length === 0 || filters.some((f) => task.id.startsWith(f)),
	);
	process.stdout.write(
		`Running ${tasks.length} task(s), concurrency ${args.concurrency}${args.dry ? " (dry)" : ` with ${config?.model.provider}/${config?.model.model}`}\n`,
	);
	const results: TaskMetrics[] = [];
	let index = 0;
	await Promise.all(
		Array.from(
			{ length: Math.min(args.concurrency, tasks.length) },
			async () => {
				while (index < tasks.length) {
					const task = tasks[index++];
					if (task) results.push(await runTask(task, args, config));
				}
			},
		),
	);
	results.sort((a, b) => a.id.localeCompare(b.id));

	const passed = results.filter((r) => r.pass).length;
	const rows = results.map((r) =>
		[
			r.pass ? "PASS" : "FAIL",
			r.id.padEnd(28),
			`${r.rounds}r`.padStart(4),
			`${r.computerCalls}c/${r.actions}a`.padStart(8),
			`${r.screenshots}img`.padStart(6),
			`${Math.round(r.imageBytes / 1024)}KB`.padStart(7),
			`${(r.wallMs / 1000).toFixed(0)}s`.padStart(5),
			`${r.inputTokens + r.outputTokens}tok`.padStart(9),
			r.error ? `ERR ${r.error.slice(0, 60)}` : r.detail.slice(0, 60),
		].join("  "),
	);
	process.stdout.write(
		`\n${rows.join("\n")}\n\n${passed}/${results.length} passed\n`,
	);

	const outDir = resolve(args.out);
	await mkdir(outDir, { recursive: true });
	const stamp = new Date().toISOString().replaceAll(":", "").slice(0, 15);
	const outPath = join(outDir, `cua-eval-${stamp}.json`);
	await writeFile(
		outPath,
		JSON.stringify(
			{
				model: config ? config.model : null,
				dry: args.dry,
				snapshot: args.snapshot ?? null,
				passed,
				total: results.length,
				results,
			},
			null,
			2,
		),
	);
	process.stdout.write(`wrote ${outPath}\n`);
	process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
	process.stderr.write(
		`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
	);
	process.exit(1);
});
