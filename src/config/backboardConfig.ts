import { readFileSync } from "node:fs";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "../utils/errors.ts";
import type { JsonValue } from "../utils/JsonTypes.ts";
import type {
	BackboardConfigFile,
	BackboardConfigJson,
} from "./BackboardConfigTypes.ts";
import {
	parseMemoryMode,
	parseMemoryProfile,
	type ThinkingLevel,
} from "./defaults.ts";

export type { BackboardConfigFile } from "./BackboardConfigTypes.ts";

const CONFIG_DIR = ".backboard";
const CONFIG_FILE = "config.json";

export function backboardConfigPath(homeDir = os.homedir()): string {
	return path.join(homeDir, CONFIG_DIR, CONFIG_FILE);
}

export function readBackboardConfig(
	homeDir = os.homedir(),
): BackboardConfigFile {
	const file = backboardConfigPath(homeDir);

	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as JsonValue;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			return {};
		}
		const config = parsed as BackboardConfigJson;

		return {
			apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
			apiUrl:
				typeof config.apiUrl === "string" ? config.apiUrl.trim() : undefined,
			model: readModelConfig(config),
			thinking: readThinkingConfig(config),
			memory: readMemoryConfig(config),
			memoryProfile: readMemoryProfileConfig(config),
			notify: typeof config.notify === "boolean" ? config.notify : undefined,
			verbose: typeof config.verbose === "boolean" ? config.verbose : undefined,
		};
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return {};
		throw new Error(`Failed to read ${file}: ${errorMessage(err)}`);
	}
}

function readModelConfig(
	config: BackboardConfigJson,
): BackboardConfigFile["model"] {
	const model = config.model;
	if (typeof model !== "object" || model === null || Array.isArray(model)) {
		return undefined;
	}
	const modelConfig = model as BackboardConfigJson;
	if (
		typeof modelConfig.provider !== "string" ||
		typeof modelConfig.model !== "string"
	) {
		return undefined;
	}
	return { provider: modelConfig.provider, model: modelConfig.model };
}

function readMemoryConfig(
	config: BackboardConfigJson,
): BackboardConfigFile["memory"] {
	if (typeof config.memory !== "string") return undefined;
	try {
		return parseMemoryMode(config.memory);
	} catch {
		return undefined;
	}
}

function readMemoryProfileConfig(
	config: BackboardConfigJson,
): BackboardConfigFile["memoryProfile"] {
	if (typeof config.memoryProfile !== "string") return undefined;
	try {
		return parseMemoryProfile(config.memoryProfile);
	} catch {
		return undefined;
	}
}

function readThinkingConfig(
	config: BackboardConfigJson,
): BackboardConfigFile["thinking"] {
	if (!("thinking" in config)) return undefined;
	const { thinking } = config;
	if (thinking === null) return null;
	if (
		typeof thinking !== "object" ||
		thinking === null ||
		Array.isArray(thinking)
	) {
		return undefined;
	}
	const thinkingConfig = thinking as BackboardConfigJson;
	if (Object.keys(thinkingConfig).length === 0) return undefined;

	if (
		thinkingConfig.kind === "level" &&
		isThinkingLevel(thinkingConfig.level)
	) {
		return { kind: "level", level: thinkingConfig.level };
	}
	if (thinkingConfig.kind === "dynamic") {
		return { kind: "dynamic" };
	}
	if (
		thinkingConfig.kind === "budget" &&
		typeof thinkingConfig.tokens === "number" &&
		Number.isInteger(thinkingConfig.tokens) &&
		thinkingConfig.tokens > 0
	) {
		return { kind: "budget", tokens: thinkingConfig.tokens };
	}

	if (isThinkingEffort(thinkingConfig.effort)) {
		return { kind: "level", level: thinkingConfig.effort };
	}
	if (
		typeof thinkingConfig.budget_tokens === "number" &&
		Number.isInteger(thinkingConfig.budget_tokens) &&
		thinkingConfig.budget_tokens > 0
	) {
		return { kind: "budget", tokens: thinkingConfig.budget_tokens };
	}
	if (
		typeof thinkingConfig.max_tokens === "number" &&
		Number.isInteger(thinkingConfig.max_tokens) &&
		thinkingConfig.max_tokens > 0
	) {
		return { kind: "budget", tokens: thinkingConfig.max_tokens };
	}
	return undefined;
}

function isThinkingEffort(
	value: JsonValue | undefined,
): value is ThinkingLevel {
	return isThinkingLevel(value);
}

function isThinkingLevel(value: JsonValue | undefined): value is ThinkingLevel {
	return (
		value === "low" || value === "medium" || value === "high" || value === "max"
	);
}

export async function saveBackboardConfig(
	config: BackboardConfigFile,
	homeDir = os.homedir(),
): Promise<string> {
	const file = backboardConfigPath(homeDir);
	const dir = path.dirname(file);

	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => undefined);
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	await chmod(file, 0o600).catch(() => undefined);

	return file;
}

export async function deleteBackboardConfig(
	homeDir = os.homedir(),
): Promise<{ path: string; removed: boolean }> {
	const file = backboardConfigPath(homeDir);
	try {
		await unlink(file);
		return { path: file, removed: true };
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return { path: file, removed: false };
		}
		throw new Error(`Failed to delete ${file}: ${errorMessage(err)}`);
	}
}
