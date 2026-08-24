import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads eval credentials from the first `.env` that exists: this repo's, or
 * the sibling `Espri-API/cli-eval/.env` that already holds Daytona and
 * Backboard keys for the Harbor evals. Existing process env always wins.
 */
export function loadEvalEnv(): void {
	const candidates = [
		resolve(process.cwd(), ".env"),
		resolve(process.cwd(), "../cli-eval/.env"),
	];
	for (const path of candidates) {
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
			if (!match) continue;
			const [, key, rawValue] = match;
			if (!key || process.env[key]) continue;
			const value = (rawValue ?? "").replace(/^(['"])(.*)\1$/, "$2");
			if (value) process.env[key] = value;
		}
	}
}
