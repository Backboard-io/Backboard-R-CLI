#!/usr/bin/env bun
/**
 * Captures a grounding fixture from the live screen: the current observation
 * (screenshot + elements) plus the element that a given instruction should
 * make the agent click.
 *
 *   bun run scripts/cua-eval/capture-fixture.ts \
 *     --name calc-equals --instruction "Press the equals key" --target "equals"
 *
 * `--target` matches an element by exact name (case-insensitive), or pass
 * `--target-id el_12`. Add `--hide-target` to make the fixture test coordinate
 * grounding (the target is stripped from the element list on replay). Use
 * `--open Calculator` to bring an app to the front first, and `--window` to
 * crop the fixture to the frontmost window (so nothing else on the screen is
 * recorded; element bounds are shifted into window space).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ComputerObserver } from "../../src/core/computer/ComputerObserver.ts";
import { createPlatform } from "../../src/core/platform/Platform.ts";
import type { GroundingFixture } from "./FixturePlatform.ts";

const args = new Map<string, string>();
const flags = new Set<string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i] ?? "";
	if (!arg.startsWith("--")) continue;
	const next = argv[i + 1];
	if (next === undefined || next.startsWith("--")) flags.add(arg.slice(2));
	else {
		args.set(arg.slice(2), next);
		i++;
	}
}

const name = args.get("name");
const instruction = args.get("instruction");
if (!name || !instruction) {
	process.stderr.write(
		"usage: --name <id> --instruction <text> (--target <name> | --target-id <el_N>) [--open <app>] [--hide-target]\n",
	);
	process.exit(2);
}
const outDir = resolve(args.get("out") ?? "tests/fixtures/cua-grounding");
const platform = createPlatform();
const signal = new AbortController().signal;

try {
	if (args.get("open")) {
		await platform.execute(
			{ kind: "openApp", appName: args.get("open") as string },
			signal,
		);
		await platform.settle({ timeoutMs: 3000 }, signal);
	}
	const observer = new ComputerObserver("fixture-capture", platform);
	let observation = await observer.observe(signal, { format: "png" });
	if (flags.has("window")) {
		const window = observation.windowBounds;
		if (!window) {
			process.stderr.write("--window: the frontmost window has no bounds\n");
			process.exit(1);
		}
		const crop = await observer.observe(signal, {
			format: "png",
			region: window,
			maxWidth: Math.round(window.width),
		});
		const inside = (b: {
			x: number;
			y: number;
			width: number;
			height: number;
		}) =>
			b.x >= window.x - 1 &&
			b.y >= window.y - 1 &&
			b.x + b.width <= window.x + window.width + 1 &&
			b.y + b.height <= window.y + window.height + 1;
		observation = {
			...crop,
			region: undefined,
			screenSize: {
				width: Math.round(window.width),
				height: Math.round(window.height),
			},
			elements: observation.elements
				.filter((e) => e.bounds && inside(e.bounds))
				.map((e) => ({
					...e,
					bounds: e.bounds
						? {
								...e.bounds,
								x: e.bounds.x - window.x,
								y: e.bounds.y - window.y,
							}
						: e.bounds,
				})),
		};
	}
	const targetName = args.get("target")?.toLowerCase();
	const targetId = args.get("target-id");
	const target = observation.elements.find((e) =>
		targetId ? e.id === targetId : (e.name ?? "").toLowerCase() === targetName,
	);
	if (!target?.bounds) {
		process.stderr.write(
			`target not found. Elements:\n${observation.elements.map((e) => `  ${e.id} ${e.role} ${JSON.stringify(e.name ?? "")}`).join("\n")}\n`,
		);
		process.exit(1);
	}
	await mkdir(outDir, { recursive: true });
	const imageFile = `${name}.png`;
	await writeFile(
		join(outDir, imageFile),
		Buffer.from(observation.__image_base64 ?? "", "base64"),
	);
	const fixture: GroundingFixture = {
		name,
		instruction,
		os: observation.os,
		image: imageFile,
		mediaType: "image/png",
		screenSize: observation.screenSize,
		...(observation.appName ? { appName: observation.appName } : {}),
		...(observation.windowTitle
			? { windowTitle: observation.windowTitle }
			: {}),
		elements: observation.elements,
		expected: target.bounds,
		expectedElementId: target.id,
		...(flags.has("hide-target") ? { hideTarget: true } : {}),
	};
	await writeFile(
		join(outDir, `${name}.json`),
		`${JSON.stringify(fixture, null, "\t")}\n`,
	);
	process.stdout.write(
		`wrote ${join(outDir, `${name}.json`)} (${observation.elements.length} elements, target ${target.id} ${JSON.stringify(target.name ?? "")} at ${JSON.stringify(target.bounds)})\n`,
	);
} finally {
	await platform.dispose();
}
