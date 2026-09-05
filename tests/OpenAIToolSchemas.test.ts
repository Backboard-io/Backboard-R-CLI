import { describe, expect, it } from "bun:test";
import type { OpenAITool } from "../src/core/tools/schema.ts";
import { compatibleOpenAITools } from "../src/providers/byok/openAIToolSchemas.ts";

describe("OpenAI-compatible tool schemas", () => {
	it("inlines local references and safely breaks recursive loops", () => {
		const tools: OpenAITool[] = [
			{
				type: "function",
				function: {
					name: "agent",
					description: "Run an agent",
					parameters: {
						type: "object",
						properties: {
							payload: { $ref: "#/$defs/JsonValue" },
						},
						required: ["payload"],
						$defs: {
							JsonValue: {
								anyOf: [
									{ type: "string" },
									{
										type: "object",
										additionalProperties: {
											$ref: "#/$defs/JsonValue",
										},
									},
								],
							},
						},
					},
				},
			},
		];

		const compatible = compatibleOpenAITools(tools);
		const serialized = JSON.stringify(compatible);
		expect(serialized).not.toContain('"$ref"');
		expect(serialized).not.toContain('"$defs"');
		expect(compatible[0]?.function.parameters).toMatchObject({
			type: "object",
			required: ["payload"],
			properties: {
				payload: {
					anyOf: [
						{ type: "string" },
						{
							type: "object",
							additionalProperties: {},
						},
					],
				},
			},
		});
		expect(JSON.stringify(tools)).toContain('"$ref"');
	});
});
