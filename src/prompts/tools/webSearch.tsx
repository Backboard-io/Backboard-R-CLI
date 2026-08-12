import { definePrompt, type PromptModule } from "../PromptModule.ts";

export const webSearch: PromptModule = definePrompt(
	`Performs a web search to find relevant web pages and documents to the input query. Use this tool ONLY when the query requires finding specific factual information that would benefit from accessing current web content, such as:
      - Recent news, events, or developments
      - Up-to-date statistics, data points, or facts
      - Information about public entities (companies, organizations, people)
      - Specific published content, articles, or references
      - Current trends or technologies
      - API documents for a publicly available API
      - Public github repositories, and other public code resources
    DO NOT use for:
      - Creative generation (writing, poetry, etc.)
      - Mathematical calculations or problem-solving
      - Code generation or debugging unrelated to web resources
      - Finding code files in a repository in factory

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`query\` | \`string\` | yes | The search query string |
| \`max_results\` | \`number\` | no | Max results to return (default 8, maximum 20) |`.trim(),
);
