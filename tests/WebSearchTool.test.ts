import { afterEach, describe, expect, it } from "bun:test";
import {
	parseSearchResults,
	WebSearchTool,
} from "../src/tools/WebSearchTool.tsx";
import { makeContext } from "./helpers.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("WebSearchTool", () => {
	it("parses DuckDuckGo HTML result blocks", () => {
		const results = parseSearchResults(
			`
				<div class="result results_links results_links_deep web-result ">
					<div class="links_main links_deep result__body">
						<h2 class="result__title">
							<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fx%3D1&amp;rut=abc">Example &amp; Docs</a>
						</h2>
						<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&amp;rut=abc">A <b>useful</b> result.</a>
					</div>
				</div>
				<div class="result results_links results_links_deep web-result ">
					<div class="links_main links_deep result__body">
						<h2 class="result__title">
							<a rel="nofollow" class="result__a" href="https://example.org">Second result</a>
						</h2>
						<a class="result__snippet" href="https://example.org">Another result.</a>
					</div>
				</div>
			`,
			1,
		);

		expect(results).toEqual([
			{
				title: "Example & Docs",
				url: "https://example.com/docs?x=1",
				snippet: "A useful result.",
			},
		]);
	});

	it("fetches and returns parsed web results", async () => {
		globalThis.fetch = (async () =>
			new Response(
				`
					<div class="result results_links results_links_deep web-result ">
						<div class="links_main links_deep result__body">
							<h2 class="result__title">
								<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenai.com%2F&amp;rut=abc">OpenAI</a>
							</h2>
							<a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fopenai.com%2F&amp;rut=abc">Official site.</a>
						</div>
					</div>
				`,
				{ status: 200 },
			)) as unknown as typeof fetch;

		const tool = new WebSearchTool();
		const result = await tool.execute(
			{ query: "openai", max_results: 5 },
			makeContext(new AbortController().signal),
		);

		expect(result.title).toBe("Found 1 result");
		expect(result.data.results[0]?.url).toBe("https://openai.com/");
		expect(result.forLLM).toContain("OpenAI");
	});

	it("defaults to 8 web results", async () => {
		globalThis.fetch = (async () =>
			new Response(
				Array.from(
					{ length: 9 },
					(_, index) => `
						<div class="result results_links results_links_deep web-result ">
							<div class="links_main links_deep result__body">
								<h2 class="result__title">
									<a rel="nofollow" class="result__a" href="https://example.com/${index}">Result ${index}</a>
								</h2>
								<a class="result__snippet" href="https://example.com/${index}">Snippet ${index}.</a>
							</div>
						</div>
					`,
				).join(""),
				{ status: 200 },
			)) as unknown as typeof fetch;

		const tool = new WebSearchTool();
		const result = await tool.execute(
			{ query: "default count" },
			makeContext(new AbortController().signal),
		);

		expect(result.title).toBe("Found 8 results");
		expect(result.data.results).toHaveLength(8);
	});
});
