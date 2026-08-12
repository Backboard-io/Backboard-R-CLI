import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface OpenAITool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

/**
 * Converts a Zod object schema into the OpenAI function-calling shape Backboard
 * expects. Strips the `$schema`/`$ref` wrapper that zod-to-json-schema adds so
 * the `parameters` object is a clean JSON Schema.
 */
export function toOpenAITool(
	name: string,
	description: string,
	schema: z.ZodType,
): OpenAITool {
	const json = zodToJsonSchema(schema, {
		target: "openApi3",
		$refStrategy: "none",
	}) as Record<string, unknown>;
	delete json.$schema;

	return {
		type: "function",
		function: { name, description, parameters: json },
	};
}
