import type { OpenAITool } from "../../core/tools/schema.ts";

/**
 * OpenAI-compatible providers vary in their JSON Schema support. In particular,
 * Gemini's compatibility endpoint rejects required recursive `$ref` loops.
 * Inline local references and replace only recursive edges with a permissive
 * object so the rest of each tool contract remains intact.
 */
export function compatibleOpenAITools(
	tools: readonly OpenAITool[],
): OpenAITool[] {
	return tools.map((tool) => ({
		...tool,
		function: {
			...tool.function,
			parameters: expandSchema(
				tool.function.parameters,
				tool.function.parameters,
				new Set(),
			) as OpenAITool["function"]["parameters"],
		},
	}));
}

function expandSchema(
	value: unknown,
	root: unknown,
	activeRefs: ReadonlySet<string>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => expandSchema(entry, root, activeRefs));
	}
	if (typeof value !== "object" || value === null) return value;

	const source = value as Record<string, unknown>;
	const reference = typeof source.$ref === "string" ? source.$ref : null;
	if (reference?.startsWith("#/")) {
		if (activeRefs.has(reference)) {
			return {};
		}
		const target = resolveLocalReference(root, reference);
		if (target) {
			const nextRefs = new Set(activeRefs);
			nextRefs.add(reference);
			const expanded = expandSchema(target, root, nextRefs);
			const siblings = expandObject(source, root, activeRefs, true);
			if (
				typeof expanded === "object" &&
				expanded !== null &&
				!Array.isArray(expanded)
			) {
				return { ...(expanded as Record<string, unknown>), ...siblings };
			}
			return siblings;
		}
	}
	return expandObject(source, root, activeRefs, false);
}

function expandObject(
	source: Record<string, unknown>,
	root: unknown,
	activeRefs: ReadonlySet<string>,
	skipReference: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(source)) {
		if (
			key === "$defs" ||
			key === "definitions" ||
			(skipReference && key === "$ref")
		) {
			continue;
		}
		out[key] = expandSchema(child, root, activeRefs);
	}
	return out;
}

function resolveLocalReference(
	root: unknown,
	reference: string,
): Record<string, unknown> | null {
	let current: unknown = root;
	for (const rawPart of reference.slice(2).split("/")) {
		if (typeof current !== "object" || current === null) return null;
		const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
		current = (current as Record<string, unknown>)[part];
	}
	return typeof current === "object" &&
		current !== null &&
		!Array.isArray(current)
		? (current as Record<string, unknown>)
		: null;
}
