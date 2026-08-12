#!/usr/bin/env bun

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseModel } from "../src/config/defaults.ts";
import {
	getModelProfile,
	listModelProfiles,
	type ModelProfile,
	resolveModelProfile,
} from "../src/config/modelProfiles/index.ts";
import { canonicalToolName } from "../src/core/tools/names.ts";
import { toPromptProfileId } from "../src/prompts/profiles/ids.ts";
import { resolvePromptProfile } from "../src/prompts/profiles/index.ts";
import { getSystemPrompt } from "../src/prompts/system/index.tsx";
import { buildStartupEnvironmentPrompt } from "../src/prompts/system/startupEnvironment.ts";
import { toolPrompts } from "../src/prompts/tools/index.tsx";

interface Options {
	profileArg: string;
	outDir: string;
	dryRun: boolean;
}

const options = parseArgs(Bun.argv.slice(2));
const profile = resolveProfileArg(options.profileArg);
const outputDir = path.resolve(
	options.outDir,
	`${safeName(profile.name)}-${timestamp()}`,
);
const toolNames = selectedToolNames(profile);
const promptProfileId = toPromptProfileId(profile.name);
const profilePrompts = resolvePromptProfile(promptProfileId).toolPrompts;
const startupEnvironmentPrompt = await buildStartupEnvironmentPrompt(
	process.cwd(),
);

if (options.dryRun) {
	console.log(`Would export ${profile.name} prompts to ${outputDir}`);
	console.log(`Tools: ${toolNames.join(", ")}`);
	process.exit(0);
}

await mkdir(path.join(outputDir, "tools"), { recursive: true });

await Bun.write(
	path.join(outputDir, "profile.json"),
	`${JSON.stringify(profile, null, "\t")}\n`,
);
await Bun.write(
	path.join(outputDir, "system.md"),
	`${getSystemPrompt({
		layout: profile.systemPromptLayout,
		profile: promptProfileId,
		enabledTools: toolNames,
		startupEnvironmentPrompt,
	})}\n`,
);
await Bun.write(
	path.join(outputDir, "tools.json"),
	`${JSON.stringify(toolNames, null, "\t")}\n`,
);

for (const name of toolNames) {
	const module = profilePrompts[name];
	const prompt =
		module?.render?.({ enabledTools: toolNames, profile: promptProfileId }) ??
		module?.prompt ??
		"";
	await Bun.write(
		path.join(outputDir, "tools", `${safeName(name)}.md`),
		prompt,
	);
}

console.log(`Exported ${profile.name} prompts to ${outputDir}`);

function parseArgs(args: string[]): Options {
	let profileArg = "";
	let outDir = "prompt-dumps";
	let dryRun = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--out") {
			const next = args[i + 1];
			if (!next) usage("Missing value for --out");
			outDir = next;
			i++;
			continue;
		}
		if (!profileArg) {
			profileArg = arg;
			continue;
		}
		usage(`Unexpected argument: ${arg}`);
	}

	if (!profileArg) usage("Missing model profile or provider/model");
	return { profileArg, outDir, dryRun };
}

function resolveProfileArg(value: string): ModelProfile {
	const exact = getModelProfile(value);
	if (exact) return exact;
	if (value.includes("/")) return resolveModelProfile(parseModel(value));
	usage(`Unknown model profile: ${value}`);
}

function selectedToolNames(profile: ModelProfile): string[] {
	const allNames = Object.keys(toolPrompts);
	const excluded = new Set(
		(profile.excludedTools ?? []).map(canonicalToolName),
	);
	const names =
		profile.tools.length === 0
			? allNames
			: profile.tools.map(canonicalToolName);
	return names.filter((name) => name in toolPrompts && !excluded.has(name));
}

function safeName(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function usage(message: string): never {
	const profiles = listModelProfiles()
		.map((profile) => profile.name)
		.join(", ");
	console.error(message);
	console.error(
		"Usage: bun run scripts/export-prompts.ts <model-profile|provider/model> [--out <dir>] [--dry-run]",
	);
	console.error(`Profiles: ${profiles}`);
	process.exit(1);
}
