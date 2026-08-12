import { z } from "zod";
import { APP_PACKAGE_NAME, APP_VERSION } from "../config/branding.ts";
import type {
	PermissionCheckContext,
	PermissionDecision,
} from "../core/permissions/types.ts";
import { Tool } from "../core/tools/Tool.ts";
import type { ToolContext } from "../core/tools/ToolContext.ts";
import { ok, type ToolResult } from "../core/tools/ToolResult.ts";
import type { PromptContext } from "../prompts/PromptModule.ts";
import { getToolPrompt } from "../prompts/tools/index.tsx";
import { readLimitedResponseText } from "../utils/http.ts";
import { pluralize } from "../utils/string.ts";

const schema = z.object({
	query: z.string().describe("The search query string"),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe("Max results to return (default 8, maximum 20)"),
});

type Input = z.infer<typeof schema>;
const MAX_SEARCH_HTML_BYTES = 250_000;

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

interface Output {
	query: string;
	results: SearchResult[];
}

/**
 * Keyless web search via DuckDuckGo's HTML results page. The Instant Answer
 * API does not return general web results, so parse the standard result blocks
 * while keeping the tool contract independent of the transport.
 */
export class WebSearchTool extends Tool<Input, Output> {
	readonly name = "WebSearch";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override permissionContent(input: Input): string {
		return input.query;
	}

	override checkPermissions(
		_input: Input,
		ctx: PermissionCheckContext,
	): PermissionDecision | undefined {
		if (ctx.mode === "auto") {
			return { behavior: "allow", reason: "network read (auto mode)" };
		}
		return undefined;
	}

	override isConcurrencySafe(): boolean {
		return true;
	}

	override async execute(
		input: Input,
		ctx: ToolContext,
	): Promise<ToolResult<Output>> {
		const max = input.max_results ?? 8;
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
		const res = await fetch(url, {
			signal: ctx.signal,
			headers: {
				"User-Agent": `Mozilla/5.0 ${APP_PACKAGE_NAME}/${APP_VERSION}`,
			},
		});
		if (!res.ok) {
			throw new Error(`Web search failed: HTTP ${res.status}`);
		}
		const { text: html } = await readLimitedResponseText(
			res,
			MAX_SEARCH_HTML_BYTES,
		);
		const results = parseSearchResults(html, max);

		const body = results.length
			? results
					.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`)
					.join("\n")
			: "No results found";

		return ok(
			{ query: input.query, results },
			body,
			results.length === 0
				? "No results found"
				: `Found ${results.length} ${pluralize(results.length, "result")}`,
		);
	}
}

export function parseSearchResults(
	html: string,
	maxResults: number,
): SearchResult[] {
	const results: SearchResult[] = [];
	const linkPattern =
		/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const matches = Array.from(html.matchAll(linkPattern));

	for (const [index, link] of matches.entries()) {
		if (results.length >= maxResults) break;
		if (!link?.[1] || !link[2]) continue;
		const start = link.index ?? 0;
		const end = matches[index + 1]?.index ?? html.length;
		const block = html.slice(start, end);

		const snippet = block.match(
			/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
		);
		const url = decodeDuckDuckGoUrl(decodeHtml(link[1]));
		const title = cleanText(link[2]);
		if (!url || !title) continue;

		results.push({
			title,
			url,
			snippet: snippet?.[1] ? cleanText(snippet[1]) : "",
		});
	}

	return results;
}

function decodeDuckDuckGoUrl(raw: string): string {
	const absolute = raw.startsWith("//") ? `https:${raw}` : raw;
	try {
		const parsed = new URL(absolute);
		const target = parsed.searchParams.get("uddg");
		return target ? decodeURIComponent(target) : absolute;
	} catch {
		return raw;
	}
}

function cleanText(html: string): string {
	return decodeHtml(html.replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_match, code: string) =>
			String.fromCodePoint(Number(code)),
		)
		.replace(/&#x([\da-f]+);/gi, (_match, code: string) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}
