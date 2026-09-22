import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const repoRoot = new URL("..", import.meta.url);

function readJson(relative: string): unknown {
	return JSON.parse(readFileSync(new URL(relative, repoRoot), "utf8"));
}

function listScriptFiles(): string[] {
	const files: string[] = [];
	const direct = readdirSync(new URL("scripts/", repoRoot), {
		withFileTypes: true,
	});
	for (const entry of direct) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(`scripts/${entry.name}`);
		}
	}
	const evalDir = readdirSync(new URL("scripts/cua-eval/", repoRoot), {
		withFileTypes: true,
	});
	for (const entry of evalDir) {
		if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(`scripts/cua-eval/${entry.name}`);
		}
	}
	return files.sort();
}

function isCovered(file: string, include: string[]): boolean {
	return include.some((entry) => {
		const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
		if (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) {
			return normalized === file;
		}
		return file === normalized || file.startsWith(`${normalized}/`);
	});
}

describe("scripts typecheck coverage", () => {
	it("covers every script entrypoint in tsconfig.scripts.json", () => {
		const tsconfig = readJson("tsconfig.scripts.json") as {
			include?: string[];
		};
		const uncovered = listScriptFiles().filter(
			(file) => !isCovered(file, tsconfig.include ?? []),
		);
		expect(uncovered).toEqual([]);
	});
});
