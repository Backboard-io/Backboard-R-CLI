import { formatModel } from "../../config/defaults.ts";
import {
	CHAT_PROVIDER_PRIORITY,
	EXCLUDED_MODEL_PROVIDERS,
} from "./constants.ts";
import type { ModelCatalogItem, ModelInfo } from "./types.ts";

const excludedProviderSet = new Set<string>(EXCLUDED_MODEL_PROVIDERS);

export function isSelectableProvider(provider: string): boolean {
	const normalized = provider.trim().toLowerCase();
	return normalized.length > 0 && !excludedProviderSet.has(normalized);
}

export function normalizeSelectableModels(
	models: readonly ModelCatalogItem[],
): ModelInfo[] {
	return sortModels(dedupe(models.map(normalizeModel).filter(isModelInfo)));
}

export function normalizeModel(model: ModelCatalogItem): ModelInfo | null {
	if (model.model_type.toLowerCase() !== "llm") return null;

	const provider = model.provider.trim();
	const name = model.name.trim();
	if (!provider || !name || !isSelectableProvider(provider)) return null;

	const ref = { provider, model: name };
	const releaseTimestamp = timestamp(model.last_updated);
	return {
		id: formatModel(ref),
		provider,
		model: name,
		label: formatModel(ref),
		...(typeof model.max_output_tokens === "number" ||
		model.max_output_tokens === null
			? { max_output_tokens: model.max_output_tokens }
			: {}),
		...(typeof model.supports_thinking === "boolean" ||
		model.supports_thinking === null
			? { supports_thinking: model.supports_thinking }
			: {}),
		...(model.thinking_controls
			? { thinking_controls: model.thinking_controls }
			: {}),
		...(releaseTimestamp !== null ? { releaseTimestamp } : {}),
		...(model.source ? { source: model.source } : {}),
		...(typeof model.context_limit === "number" && model.context_limit > 0
			? { contextLimit: model.context_limit }
			: {}),
	};
}

function isModelInfo(model: ModelInfo | null): model is ModelInfo {
	return model !== null;
}

function timestamp(value: string | number | null | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function dedupe(models: ModelInfo[]): ModelInfo[] {
	const seen = new Set<string>();
	const out: ModelInfo[] = [];
	for (const model of models) {
		if (seen.has(model.label)) continue;
		seen.add(model.label);
		out.push(model);
	}
	return out;
}

function sortModels(models: ModelInfo[]): ModelInfo[] {
	return [...models].sort((a, b) => {
		const providerRank =
			providerPriority(a.provider) - providerPriority(b.provider);
		if (providerRank !== 0) return providerRank;
		const provider = a.provider.localeCompare(b.provider);
		if (provider !== 0) return provider;
		return compareModelsNewestFirst(a, b);
	});
}

function providerPriority(provider: string): number {
	const normalized = provider.toLowerCase();
	for (let index = 0; index < CHAT_PROVIDER_PRIORITY.length; index += 1) {
		if (CHAT_PROVIDER_PRIORITY[index] === normalized) return index;
	}
	return CHAT_PROVIDER_PRIORITY.length;
}

function compareModelsNewestFirst(a: ModelInfo, b: ModelInfo): number {
	const timestampDelta = (b.releaseTimestamp ?? 0) - (a.releaseTimestamp ?? 0);
	if (timestampDelta !== 0) return timestampDelta;

	const aKey = modelFreshnessKey(a.model);
	const bKey = modelFreshnessKey(b.model);
	const versionDelta = compareNumberListsDesc(aKey.version, bKey.version);
	if (versionDelta !== 0) return versionDelta;
	const dateDelta = bKey.date - aKey.date;
	if (dateDelta !== 0) return dateDelta;
	return a.model.localeCompare(b.model, undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function modelFreshnessKey(model: string): { version: number[]; date: number } {
	const lower = model.toLowerCase();
	const versionSource = lower
		.replace(/(?:19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}/g, " ")
		.replace(/(?:19|20)\d{2}[-_.]\d{2}/g, " ")
		.replace(/\d{2}[-_.](?:19|20)\d{2}/g, " ")
		.replace(/\b(?:19|20)\d{2}\b/g, " ");
	const version = (versionSource.match(/\d+(?:\.\d+)?/g) ?? []).flatMap(
		(part) => part.split(".").map((n) => Number(n)),
	);
	return {
		version,
		date: modelDateRank(lower),
	};
}

function modelDateRank(model: string): number {
	let rank = 0;
	for (const match of model.matchAll(
		/((?:19|20)\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/g,
	)) {
		rank = Math.max(rank, dateRank(match[1], match[2], match[3]));
	}
	for (const match of model.matchAll(/((?:19|20)\d{2})[-_.](\d{2})/g)) {
		rank = Math.max(rank, dateRank(match[1], match[2]));
	}
	for (const match of model.matchAll(/(\d{2})[-_.]((?:19|20)\d{2})/g)) {
		rank = Math.max(rank, dateRank(match[2], match[1]));
	}
	for (const match of model.matchAll(
		/(?<![-_.])\b((?:19|20)\d{2})\b(?![-_.])/g,
	)) {
		rank = Math.max(rank, dateRank(match[1]));
	}
	return rank;
}

function dateRank(
	year: string | undefined,
	month?: string,
	day?: string,
): number {
	const y = Number(year);
	if (!Number.isInteger(y)) return 0;

	const m = month === undefined ? 0 : Number(month);
	if (!Number.isInteger(m) || m < 0 || m > 12) return 0;
	if (month !== undefined && m === 0) return 0;

	const d = day === undefined ? 0 : Number(day);
	if (!Number.isInteger(d) || d < 0) return 0;
	if (day !== undefined) {
		if (d === 0 || m === 0) return 0;
		const maxDay = new Date(y, m, 0).getDate();
		if (d > maxDay) return 0;
	}

	return y * 10000 + m * 100 + d;
}

function compareNumberListsDesc(a: number[], b: number[]): number {
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i += 1) {
		const delta = (b[i] ?? 0) - (a[i] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}
