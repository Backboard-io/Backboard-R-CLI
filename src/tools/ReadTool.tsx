import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { z } from "zod";
import {
	ImageContent,
	type ImageContentPayload,
} from "../core/image/ImageContent.ts";
import {
	asNumber,
	asString,
	lineRange,
	relativizePath,
} from "../core/tools/inputSummary.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import {
	READ_TOOL_DEFAULT_LINE_LIMIT,
	READ_TOOL_IMAGE_MIME_BY_EXTENSION,
	READ_TOOL_MAX_BYTES,
} from "./ReadTool.constants.ts";

const schema = z.object({
	file_path: z
		.string()
		.describe(
			"The path to the file to read. Absolute, or relative to the working directory.",
		),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe("The line number to start reading from (0-based, defaults to 0)"),
	limit: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe("The maximum number of lines to read (defaults to 2400)"),
});

type Input = z.infer<typeof schema>;

interface TextOutput {
	filePath: string;
	content: string;
	totalLines: number;
	truncated: boolean;
}

interface ImageOutput extends ImageContentPayload {
	filePath: string;
	contentType: "image";
	mimeType: string;
	sizeBytes: number;
}

type Output = TextOutput | ImageOutput;

export class ReadTool extends Tool<Input, Output> {
	readonly name = "Read";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override summarizeInput(input: Input): string | undefined {
		const filePath = asString(input.file_path);
		if (!filePath) return undefined;
		return (
			relativizePath(filePath) +
			lineRange(asNumber(input.offset), asNumber(input.limit))
		);
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const filePath = await resolveReadablePath(
			resolve(ctx.cwd, decodeUnicodeEscapes(input.file_path)),
		);
		const info = await stat(filePath);
		if (info.size > READ_TOOL_MAX_BYTES) {
			throw new Error(
				`File too large (${info.size} bytes); limit is ${READ_TOOL_MAX_BYTES}`,
			);
		}

		const imageMimeType = imageMimeTypeForPath(filePath);
		if (imageMimeType) {
			const bytes = await readFile(filePath);
			const output: ImageOutput = {
				filePath,
				contentType: "image",
				mimeType: imageMimeType,
				sizeBytes: info.size,
				...ImageContent.fromBytes(bytes, imageMimeType),
			};
			return ok(
				output,
				JSON.stringify(output),
				`Read image (${imageMimeType}, ${info.size} bytes)`,
			);
		}

		const raw = await readFile(filePath, "utf8");
		const lines = raw.split("\n");
		const total = lines.length;

		// Pre-warm the language server for this file so diagnostics are hot before
		// the model edits it. Fire-and-forget: never blocks or fails the read.
		if (ctx.lsp?.enabled) {
			void ctx.lsp.touchFile(filePath).catch(() => {});
		}

		const start = input.offset ?? 0;
		const end = input.limit
			? start + input.limit
			: Math.min(start + READ_TOOL_DEFAULT_LINE_LIMIT, total);
		const slice = lines.slice(start, end);
		const truncated = end < total || start > 0;

		const content = slice.join("\n");
		return ok(
			{ filePath, content, totalLines: total, truncated },
			content,
			truncated
				? `Read ${slice.length}/${total} lines`
				: `Read ${slice.length} lines`,
		);
	}
}

function imageMimeTypeForPath(filePath: string): string | null {
	return (
		READ_TOOL_IMAGE_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase()) ??
		null
	);
}

/** Turns literal unicode escapes (`\u{202f}`, ` `) into the real glyph. */
function decodeUnicodeEscapes(value: string): string {
	if (!value.includes("\\u")) return value;
	const fromHex = (original: string, hex: string): string => {
		const code = Number.parseInt(hex, 16);
		if (!Number.isFinite(code) || code > 0x10ffff) return original;
		try {
			return String.fromCodePoint(code);
		} catch {
			return original;
		}
	};
	return value
		.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => fromHex(m, hex))
		.replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => fromHex(m, hex));
}

/** Whitespace-insensitive path fallback (macOS U+202F screenshot names). */
async function resolveReadablePath(filePath: string): Promise<string> {
	try {
		await stat(filePath);
		return filePath;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	const dir = dirname(filePath);
	const target = basename(filePath).replace(/\s+/g, " ");
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return filePath;
	}
	for (const entry of entries) {
		if (entry.replace(/\s+/g, " ") === target) return join(dir, entry);
	}
	return filePath;
}
