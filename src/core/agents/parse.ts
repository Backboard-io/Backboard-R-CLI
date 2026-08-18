import { parseDocument } from "yaml";
import { parseModel } from "../../config/defaults.ts";
import type { AgentMode } from "../tools/AgentToolOutput.ts";
import type { AgentDefinition, AgentSource } from "./AgentDefinition.ts";

const AGENT_NAME_PATTERN = /^[a-z0-9-]+$/;
const MAX_AGENT_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;

export interface AgentLoadResult {
	agent?: AgentDefinition;
	warning?: string;
}

export function parseAgentFromMarkdown(
	content: string,
	fileStem: string,
	filePath: string,
	source: AgentSource,
): AgentLoadResult {
	const skip = (reason: string): AgentLoadResult => ({
		warning: `Skipped agent at ${filePath}: ${reason}`,
	});

	const parsed = FRONTMATTER_PATTERN.exec(content);
	if (!parsed) return skip("missing YAML frontmatter.");

	const doc = parseDocument(parsed[1] ?? "");
	if (doc.errors.length > 0) return skip("invalid YAML frontmatter.");

	const data = doc.toJSON() as unknown;
	if (!isRecord(data)) return skip("frontmatter must be a map.");

	const body = (parsed[2] ?? "").trim();
	if (!body) return skip("missing system prompt body.");

	// Names are matched exactly by subagent_type, so the rule is stated rather
	// than normalized: silently lowercasing would make Researcher.md and
	// researcher.md collide on one name.
	const name = stringValue(data.name) ?? fileStem;
	if (name.length > MAX_AGENT_NAME_LENGTH) {
		return skip(
			`agent name '${name}' exceeds ${MAX_AGENT_NAME_LENGTH} characters.`,
		);
	}
	if (!AGENT_NAME_PATTERN.test(name)) {
		return skip(
			`invalid agent name '${name}' — use lowercase letters, digits, and hyphens only (rename the file, or set a 'name:' in frontmatter).`,
		);
	}

	const description = stringValue(data.description);
	if (!description) return skip("missing description.");
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return skip(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`);
	}

	const mode = parseMode(data.mode);
	if (!mode) return skip('mode must be "worker" or "rlm".');

	const tools = stringList(data.tools);
	if (tools === INVALID) return skip("tools must be a list of strings.");

	const disallowedTools = stringList(data.disallowedTools);
	if (disallowedTools === INVALID) {
		return skip("disallowedTools must be a list of strings.");
	}

	const modelValue = stringValue(data.model);
	const model =
		modelValue && modelValue !== "inherit" ? parseModel(modelValue) : undefined;

	const maxRounds = positiveInt(data.maxRounds);
	if (maxRounds === INVALID) {
		return skip("maxRounds must be a positive integer.");
	}

	const timeoutMs = positiveInt(data.timeoutMs);
	if (timeoutMs === INVALID) {
		return skip("timeoutMs must be a positive integer.");
	}

	const background = boolValue(data.background);
	if (background === INVALID) return skip("background must be a boolean.");
	if (background && mode === "rlm") {
		return skip("background is not supported for rlm agents.");
	}

	return {
		agent: {
			name,
			description,
			mode,
			systemPrompt: body,
			...(tools ? { tools } : {}),
			...(disallowedTools ? { disallowedTools } : {}),
			...(model ? { model } : {}),
			...(maxRounds !== undefined ? { maxRounds } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(background !== undefined ? { background } : {}),
			source,
			path: filePath,
		},
	};
}

const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

function parseMode(value: unknown): AgentMode | null {
	if (value === undefined) return "worker";
	const mode = stringValue(value);
	return mode === "worker" || mode === "rlm" ? mode : null;
}

function stringList(value: unknown): string[] | undefined | Invalid {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return INVALID;
	const items: string[] = [];
	for (const item of value) {
		const parsed = stringValue(item);
		if (!parsed) return INVALID;
		items.push(parsed);
	}
	return items;
}

function positiveInt(value: unknown): number | undefined | Invalid {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return INVALID;
	}
	return value;
}

function boolValue(value: unknown): boolean | undefined | Invalid {
	if (value === undefined) return undefined;
	return typeof value === "boolean" ? value : INVALID;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
