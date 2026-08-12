import { describe, expect, it } from "bun:test";
import { toGoogleSchema } from "../src/providers/byok/googleSchema.ts";

describe("toGoogleSchema", () => {
	it("uppercases types and keeps the supported keywords", () => {
		expect(
			toGoogleSchema({
				type: "object",
				description: "Read a file",
				properties: {
					path: { type: "string", description: "Path to read" },
					lines: { type: "integer" },
				},
				required: ["path"],
			}),
		).toEqual({
			type: "OBJECT",
			description: "Read a file",
			properties: {
				path: { type: "STRING", description: "Path to read" },
				lines: { type: "INTEGER" },
			},
			required: ["path"],
		});
	});

	it("drops keywords Gemini rejects", () => {
		const converted = toGoogleSchema({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			additionalProperties: false,
			properties: {
				mode: { type: "string", default: "read", pattern: "^r" },
			},
		});

		expect(converted).not.toHaveProperty("$schema");
		expect(converted).not.toHaveProperty("additionalProperties");
		expect(converted?.properties).toEqual({ mode: { type: "STRING" } });
	});

	it("converts a nullable type union", () => {
		expect(toGoogleSchema({ type: ["string", "null"] })).toEqual({
			type: "STRING",
			nullable: true,
		});
	});

	it("converts const into a single-value enum", () => {
		expect(toGoogleSchema({ const: "exact" })).toEqual({
			type: "STRING",
			enum: ["exact"],
		});
	});

	it("recurses into array items and nested objects", () => {
		expect(
			toGoogleSchema({
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					properties: { id: { type: "number" } },
				},
			}),
		).toEqual({
			type: "ARRAY",
			items: {
				type: "OBJECT",
				properties: { id: { type: "NUMBER" } },
			},
		});
	});

	it("keeps only formats Gemini accepts for the type", () => {
		expect(toGoogleSchema({ type: "string", format: "uri" })).toEqual({
			type: "STRING",
		});
		expect(toGoogleSchema({ type: "string", format: "date-time" })).toEqual({
			type: "STRING",
			format: "date-time",
		});
	});

	it("gives a property-less object an empty property bag", () => {
		expect(toGoogleSchema({ type: "object" })).toEqual({
			type: "OBJECT",
			properties: {},
		});
	});

	it("returns null for a schema with nothing usable left", () => {
		expect(toGoogleSchema(undefined)).toBeNull();
		expect(toGoogleSchema({ $schema: "x" })).toBeNull();
	});
});
