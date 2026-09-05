import type { JsonObject, JsonValue } from "../utils/JsonTypes.ts";

export const CUSTOM_PROVIDER_PROTOCOLS = [
	"openai-chat",
	"openai-responses",
	"anthropic-messages",
] as const;

export type CustomProviderProtocol = (typeof CUSTOM_PROVIDER_PROTOCOLS)[number];
export type CustomProviderAuth =
	| { type: "apiKey" }
	| { type: "env"; variable: string }
	| { type: "none" };

export interface CustomModelDefinition {
	id: string;
	name?: string;
	contextLimit?: number;
	maxOutputTokens?: number;
	noImageSupport?: boolean;
	supportsThinking?: boolean;
	enabled?: boolean;
	extraArgs?: JsonObject;
}

export interface CustomProviderDefinition {
	id: string;
	name: string;
	protocol: CustomProviderProtocol;
	baseUrl: string;
	enabled?: boolean;
	auth?: CustomProviderAuth;
	headers?: Record<string, string>;
	extraArgs?: JsonObject;
	discoverModels?: boolean;
	modelsPath?: string;
	models?: CustomModelDefinition[];
}

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const RESERVED_CUSTOM_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"anthropic",
	"openai",
	"google",
	"openrouter",
	"gemini",
	"google-gemini",
]);

export function normalizeProviderId(value: string): string {
	return value.trim().toLowerCase();
}

export function isValidProviderId(value: string): boolean {
	return PROVIDER_ID_PATTERN.test(normalizeProviderId(value));
}

export function parseCustomProviders(
	value: JsonValue | undefined,
): CustomProviderDefinition[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const providers: CustomProviderDefinition[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const provider = parseProvider(entry);
		if (!provider || seen.has(provider.id)) continue;
		seen.add(provider.id);
		providers.push(provider);
	}
	return providers;
}

export function normalizeCustomProviderDefinition(
	definition: CustomProviderDefinition,
): CustomProviderDefinition {
	const json = JSON.parse(JSON.stringify([definition])) as JsonValue;
	const parsed = parseCustomProviders(json)?.[0];
	if (!parsed) throw new Error("The custom provider configuration is invalid.");
	return parsed;
}

function parseProvider(value: JsonValue): CustomProviderDefinition | null {
	if (!isObject(value)) return null;
	if (
		typeof value.id !== "string" ||
		!isValidProviderId(value.id) ||
		typeof value.name !== "string" ||
		!value.name.trim() ||
		typeof value.protocol !== "string" ||
		!isProtocol(value.protocol) ||
		typeof value.baseUrl !== "string" ||
		!isHttpUrlTemplate(value.baseUrl)
	) {
		return null;
	}
	const id = normalizeProviderId(value.id);
	if (RESERVED_CUSTOM_PROVIDER_IDS.has(id)) return null;
	const provider: CustomProviderDefinition = {
		id,
		name: value.name.trim(),
		protocol: value.protocol,
		baseUrl: trimUrl(value.baseUrl),
	};
	if (typeof value.enabled === "boolean") provider.enabled = value.enabled;
	const auth = parseAuth(value.auth);
	const headers = stringRecord(value.headers);
	if (value.headers !== undefined && headers === null) return null;
	if (usesCredentials(auth, headers) && !isSecureProviderUrl(value.baseUrl)) {
		return null;
	}
	if (auth) provider.auth = auth;
	if (headers) provider.headers = headers;
	const extraArgs = jsonObject(value.extraArgs);
	if (extraArgs) provider.extraArgs = extraArgs;
	if (typeof value.discoverModels === "boolean") {
		provider.discoverModels = value.discoverModels;
	}
	if (typeof value.modelsPath === "string" && value.modelsPath.trim()) {
		if (
			usesCredentials(auth, headers) &&
			/^https?:\/\//i.test(value.modelsPath.trim()) &&
			!isSecureProviderUrl(value.modelsPath)
		) {
			return null;
		}
		provider.modelsPath = value.modelsPath.trim();
	}
	const models = parseModels(value.models);
	if (models) provider.models = models;
	return provider;
}

function parseAuth(value: JsonValue | undefined): CustomProviderAuth | null {
	if (!isObject(value) || typeof value.type !== "string") return null;
	if (value.type === "apiKey" || value.type === "none") {
		return { type: value.type };
	}
	if (
		value.type === "env" &&
		typeof value.variable === "string" &&
		/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.variable.trim())
	) {
		return { type: "env", variable: value.variable.trim() };
	}
	return null;
}

function parseModels(
	value: JsonValue | undefined,
): CustomModelDefinition[] | null {
	if (!Array.isArray(value)) return null;
	const models: CustomModelDefinition[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (!isObject(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
			continue;
		}
		const id = entry.id.trim();
		if (seen.has(id.toLowerCase())) continue;
		seen.add(id.toLowerCase());
		const model: CustomModelDefinition = { id };
		if (typeof entry.name === "string" && entry.name.trim()) {
			model.name = entry.name.trim();
		}
		const contextLimit = positiveInteger(entry.contextLimit);
		if (contextLimit) model.contextLimit = contextLimit;
		const maxOutputTokens = positiveInteger(entry.maxOutputTokens);
		if (maxOutputTokens) model.maxOutputTokens = maxOutputTokens;
		if (typeof entry.noImageSupport === "boolean") {
			model.noImageSupport = entry.noImageSupport;
		}
		if (typeof entry.supportsThinking === "boolean") {
			model.supportsThinking = entry.supportsThinking;
		}
		if (typeof entry.enabled === "boolean") model.enabled = entry.enabled;
		const extraArgs = jsonObject(entry.extraArgs);
		if (extraArgs) model.extraArgs = extraArgs;
		models.push(model);
	}
	return models;
}

export function resolveEnvReferences(
	value: string,
	label: string,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
		const resolved = env[name];
		if (resolved === undefined) {
			throw new Error(
				`${label} references missing environment variable ${name}.`,
			);
		}
		return resolved;
	});
}

export function resolveProviderHeaders(
	provider: CustomProviderDefinition,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(provider.headers ?? {})) {
		if (
			isCredentialHeader(name) &&
			!/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value)
		) {
			throw new Error(
				`${provider.name} header ${name} may contain a secret; reference an environment variable instead of storing it in config.json.`,
			);
		}
		headers[name] = resolveEnvReferences(
			value,
			`${provider.name} header ${name}`,
			env,
		);
	}
	return headers;
}

export function isCredentialHeader(name: string): boolean {
	return /(?:authorization|cookie|token|secret|api[-_]?key|credential|password|(?:^|[-_])auth(?:$|[-_]))/i.test(
		name.trim(),
	);
}

export function resolveJsonEnvReferences(
	value: JsonValue,
	label: string,
	env: NodeJS.ProcessEnv = process.env,
): JsonValue {
	if (typeof value === "string") return resolveEnvReferences(value, label, env);
	if (Array.isArray(value)) {
		return value.map((entry) => resolveJsonEnvReferences(entry, label, env));
	}
	if (typeof value === "object" && value !== null) {
		const resolved: JsonObject = {};
		for (const [key, entry] of Object.entries(value)) {
			resolved[key] = resolveJsonEnvReferences(entry, `${label}.${key}`, env);
		}
		return resolved;
	}
	return value;
}

export function joinProviderUrl(baseUrl: string, endpoint: string): string {
	const base = trimUrl(baseUrl);
	const suffix = endpoint.trim();
	if (!suffix) return base;
	if (/^https?:\/\//i.test(suffix)) return trimUrl(suffix);
	const normalizedSuffix = suffix.replace(/^\/+/, "");
	const basePath = new URL(base).pathname.replace(/\/+$/, "");
	if (
		basePath &&
		basePath !== "/" &&
		(normalizedSuffix === basePath.slice(1) ||
			normalizedSuffix.startsWith(`${basePath.slice(1)}/`))
	) {
		return `${new URL(base).origin}/${normalizedSuffix}`;
	}
	return `${base}/${normalizedSuffix}`;
}

function isProtocol(value: string): value is CustomProviderProtocol {
	return (CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(value);
}

function trimUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

function isHttpUrlTemplate(value: string): boolean {
	try {
		const url = new URL(
			value.trim().replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "placeholder"),
		);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

export function isSecureProviderUrl(value: string): boolean {
	try {
		const url = new URL(
			value.trim().replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, "placeholder"),
		);
		if (url.protocol === "https:") return true;
		if (url.protocol !== "http:") return false;
		const host = url.hostname.toLowerCase();
		return (
			host === "localhost" ||
			host.endsWith(".localhost") ||
			host === "::1" ||
			host === "[::1]" ||
			/^127(?:\.\d{1,3}){3}$/.test(host)
		);
	} catch {
		return false;
	}
}

function usesCredentials(
	auth: CustomProviderAuth | null,
	headers: Record<string, string> | null,
): boolean {
	return (
		(auth?.type ?? "apiKey") !== "none" ||
		Object.keys(headers ?? {}).some(isCredentialHeader)
	);
}

function positiveInteger(value: JsonValue | undefined): number | null {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value > 0 &&
		Number.isSafeInteger(value)
		? value
		: null;
}

function stringRecord(
	value: JsonValue | undefined,
): Record<string, string> | null {
	if (!isObject(value)) return null;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (
			!key.trim() ||
			/[\r\n]/.test(key) ||
			typeof entry !== "string" ||
			/[\r\n]/.test(entry)
		) {
			return null;
		}
		record[key] = entry;
	}
	return record;
}

function jsonObject(value: JsonValue | undefined): JsonObject | null {
	return isObject(value) ? value : null;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
