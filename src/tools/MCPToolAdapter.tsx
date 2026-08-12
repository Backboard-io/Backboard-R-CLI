import { z } from "zod";
import type { McpCallResult, McpToolDefinition } from "../core/mcp/MCPTypes.ts";
import type { OpenAITool } from "../core/tools/schema.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";

interface McpToolOutput {
	serverName: string;
	toolName: string;
	result: McpCallResult;
}

export class McpToolAdapter extends Tool<
	Record<string, unknown>,
	McpToolOutput
> {
	readonly name: string;
	readonly inputSchema = z.record(z.unknown());

	constructor(private readonly definition: McpToolDefinition) {
		super();
		this.name = definition.registeredName;
	}

	override prompt(): string {
		return this.definition.description;
	}

	override parseInput(raw: unknown): Record<string, unknown> {
		if (raw === undefined || raw === null) return {};
		if (typeof raw === "object" && !Array.isArray(raw)) {
			return raw as Record<string, unknown>;
		}
		throw new Error("MCP tool arguments must be an object");
	}

	override toJSONSchema(): OpenAITool {
		return {
			type: "function",
			function: {
				name: this.agentName,
				description: this.prompt(),
				parameters: normalizeInputSchema(this.definition.inputSchema),
			},
		};
	}

	private claimsReadOnly(): boolean {
		return (
			this.definition.annotations?.readOnlyHint === true &&
			this.definition.annotations?.destructiveHint !== true
		);
	}

	override isReadOnly(_input: Record<string, unknown>): boolean {
		return this.definition.trustAnnotations && this.claimsReadOnly();
	}

	override permissionHint(_input: Record<string, unknown>): string | undefined {
		if (this.definition.trustAnnotations || !this.claimsReadOnly()) {
			return undefined;
		}
		return `The server marks this tool read-only; set trustToolAnnotations: true for '${this.definition.serverName}' in your user MCP config to skip these prompts.`;
	}

	// Deliberately not gated on trustAnnotations: concurrency is a scheduling
	// hint where trusting the server costs nothing, unlike isReadOnly, which
	// feeds a permission decision.
	override isConcurrencySafe(_input: Record<string, unknown>): boolean {
		return this.claimsReadOnly();
	}

	override isDestructive(_input: Record<string, unknown>): boolean {
		return this.definition.annotations?.destructiveHint === true;
	}

	async execute(
		input: Record<string, unknown>,
		ctx: ToolContext,
	): Promise<ToolResult<McpToolOutput>> {
		const result = await this.definition.call(
			omitInvalidOptionalNulls(input, this.definition.inputSchema),
			ctx,
		);
		const title =
			"isError" in result && result.isError === true
				? `MCP ${this.definition.serverName}.${this.definition.toolName} returned an error`
				: `MCP ${this.definition.serverName}.${this.definition.toolName}`;
		return ok(
			{
				serverName: this.definition.serverName,
				toolName: this.definition.toolName,
				result,
			},
			formatMcpResult(this.definition, result),
			title,
		);
	}
}

function omitInvalidOptionalNulls(
	input: Record<string, unknown>,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	if (!isRecord(schema.properties)) return input;
	const required = requiredProperties(schema);
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const propertySchema = schema.properties[key];
		if (value === null) {
			if (!required.has(key) && !schemaAllowsNull(propertySchema)) continue;
			next[key] = value;
			continue;
		}
		if (isRecord(value) && isRecord(propertySchema)) {
			next[key] = omitInvalidOptionalNulls(value, propertySchema);
			continue;
		}
		next[key] = value;
	}
	return next;
}

function requiredProperties(schema: Record<string, unknown>): Set<string> {
	if (!Array.isArray(schema.required)) return new Set();
	return new Set(
		schema.required.filter((key): key is string => typeof key === "string"),
	);
}

function schemaAllowsNull(schema: unknown): boolean {
	if (!isRecord(schema)) return false;
	if (schema.type === "null") return true;
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	if (Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsNull))
		return true;
	if (Array.isArray(schema.oneOf) && schema.oneOf.some(schemaAllowsNull))
		return true;
	return false;
}

function normalizeInputSchema(
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const normalized = { ...schema };
	delete normalized.$schema;
	return normalized;
}

function formatMcpResult(
	definition: McpToolDefinition,
	result: McpCallResult,
): string {
	const lines = [
		`MCP result from ${definition.serverName}.${definition.toolName}:`,
	];
	if ("toolResult" in result) {
		lines.push(formatJson(result.toolResult));
		return lines.join("\n");
	}

	if (result.isError === true) {
		lines.push("Tool returned an error.");
	}
	if (result.content.length > 0) {
		for (const item of result.content) lines.push(formatContent(item));
	}
	if (result.structuredContent !== undefined) {
		lines.push("Structured content:", formatJson(result.structuredContent));
	}
	if (lines.length === 1) lines.push("No content returned.");
	return lines.join("\n\n");
}

type ContentResult = Extract<McpCallResult, { content: unknown[] }>;
type McpContentItem = ContentResult["content"][number];

function formatContent(item: McpContentItem): string {
	if (!isRecord(item)) return formatJson(item);
	switch (item.type) {
		case "text":
			return typeof item.text === "string" ? item.text : formatJson(item);
		case "image":
		case "audio": {
			const mimeType =
				typeof item.mimeType === "string" ? item.mimeType : "unknown MIME type";
			const dataLength = typeof item.data === "string" ? item.data.length : 0;
			return `[${item.type} content: ${mimeType}, ${dataLength} base64 characters]`;
		}
		case "resource": {
			const resource: Record<string, unknown> = isRecord(item.resource)
				? item.resource
				: {};
			const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
			if (typeof resource.text === "string") {
				return `Resource ${uri}:\n${resource.text}`;
			}
			const blobLength =
				typeof resource.blob === "string" ? resource.blob.length : 0;
			return `[resource content: ${uri}, ${blobLength} base64 characters]`;
		}
		case "resource_link": {
			const name = typeof item.name === "string" ? item.name : "resource";
			const uri = typeof item.uri === "string" ? item.uri : "unknown";
			return `[resource link: ${name} at ${uri}]`;
		}
		default:
			return formatJson(item);
	}
}

function formatJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
