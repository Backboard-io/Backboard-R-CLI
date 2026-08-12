import { definePrompt, type PromptModule } from "../../../PromptModule.ts";

export const webSearch: PromptModule = definePrompt(
	`Search the web for pages and documents relevant to a query. Use it ONLY when the answer needs specific facts best sourced from current web content, such as:
      - Recent news, events, or developments
      - Up-to-date statistics, data points, or facts
      - Information about public entities (companies, organizations, people)
      - Specific published content, articles, or references
      - Current trends or technologies
      - Documentation for a publicly available API
      - Public GitHub repositories and other public code resources
    Do NOT use it for:
      - Creative generation (writing, poetry, etc.)
      - Math or problem-solving
      - Code generation or debugging unrelated to web resources
      - Finding code files in a repository

    IMPORTANT - use the correct year in queries:
      - Today's date is given in the environment context at the start of the session. Use that year for anything recent: documentation, current events, and so on.
      - Example: if today's date says 2026 and the user wants the "latest React docs", search "React documentation 2026", not "React documentation 2025".

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`query\` | \`string\` | yes | The search query string |
| \`max_results\` | \`number\` | no | Max results to return (default 8, maximum 20) |`.trim(),
);
