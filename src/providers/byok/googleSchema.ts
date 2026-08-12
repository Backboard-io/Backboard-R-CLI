/**
 * Google's `functionDeclarations` take an OpenAPI-3 Schema subset, not full
 * JSON Schema: unknown keywords are rejected outright rather than ignored. The
 * CLI's tool schemas come from zod-to-json-schema, so they routinely carry
 * `additionalProperties`, `const`, `default`, and union keywords that Gemini
 * refuses. This narrows a schema to the accepted subset.
 */

const ALLOWED_KEYS = new Set([
	"type",
	"format",
	"description",
	"nullable",
	"enum",
	"items",
	"properties",
	"required",
	"minItems",
	"maxItems",
	"anyOf",
]);

/** Formats Gemini accepts, by type. Anything else is dropped. */
const ALLOWED_FORMATS: Record<string, Set<string>> = {
	STRING: new Set(["enum", "date-time"]),
	INTEGER: new Set(["int32", "int64"]),
	NUMBER: new Set(["float", "double"]),
};

export function toGoogleSchema(
	schema: unknown,
): Record<string, unknown> | null {
	const converted = convert(schema);
	return converted && Object.keys(converted).length > 0 ? converted : null;
}

function convert(schema: unknown): Record<string, unknown> | null {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return null;
	}
	const source = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	const { type, nullable } = readType(source.type);
	if (type) out.type = type;
	if (nullable) out.nullable = true;

	for (const [key, value] of Object.entries(source)) {
		if (key === "type" || !ALLOWED_KEYS.has(key)) continue;

		if (key === "properties") {
			const properties = convertProperties(value);
			if (properties) out.properties = properties;
			continue;
		}
		if (key === "items") {
			const items = convert(value);
			if (items) out.items = items;
			continue;
		}
		if (key === "anyOf") {
			const variants = Array.isArray(value)
				? value.map(convert).filter(isSchema)
				: [];
			if (variants.length > 0) out.anyOf = variants;
			continue;
		}
		if (key === "format") {
			const allowed = ALLOWED_FORMATS[String(out.type ?? "")];
			if (typeof value === "string" && allowed?.has(value)) out.format = value;
			continue;
		}
		if (key === "required") {
			if (Array.isArray(value) && value.length > 0) out.required = value;
			continue;
		}
		out[key] = value;
	}

	// `const` has no Gemini equivalent; a single-value enum is exact.
	if ("const" in source && !("enum" in out)) {
		out.enum = [source.const];
		out.type ??= "STRING";
	}

	// An object with no declared properties is rejected; describe it as a
	// free-form string instead of sending an unusable declaration.
	if (out.type === "OBJECT" && !out.properties) {
		return {
			type: "OBJECT",
			properties: {},
			...(out.description ? { description: out.description } : {}),
		};
	}
	return out;
}

function convertProperties(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const properties: Record<string, unknown> = {};
	for (const [name, child] of Object.entries(value)) {
		const converted = convert(child);
		if (converted) properties[name] = converted;
	}
	return Object.keys(properties).length > 0 ? properties : null;
}

/** Handles both `"string"` and JSON Schema's `["string", "null"]` union form. */
function readType(value: unknown): { type: string | null; nullable: boolean } {
	if (typeof value === "string") {
		return { type: value.toUpperCase(), nullable: false };
	}
	if (Array.isArray(value)) {
		const names = value.filter(
			(entry): entry is string => typeof entry === "string",
		);
		const concrete = names.find((name) => name !== "null");
		return {
			type: concrete ? concrete.toUpperCase() : null,
			nullable: names.includes("null"),
		};
	}
	return { type: null, nullable: false };
}

function isSchema(
	value: Record<string, unknown> | null,
): value is Record<string, unknown> {
	return value !== null;
}
