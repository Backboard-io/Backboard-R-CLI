import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../PromptModule.ts";

export const fetchUrl: PromptModule = definePrompt(
	buildFetchUrlPrompt(),
	buildFetchUrlPrompt,
);

function buildFetchUrlPrompt(context: PromptContext = {}): string {
	return `Scrapes content from URLs that the user provided, and returns the contents in raw format. This tool supports both generic webpages and specific integration URLs.

CRITICAL: BEFORE CALLING THIS TOOL, CHECK IF THE URL WILL FAIL

URLs THAT WILL ALWAYS FAIL - DO NOT ATTEMPT TO FETCH:

1. NON-HTTP PROTOCOLS:
   - file:/// (local file system)
   - ssh://, ftp://, powershell://
   - view-source: (browser-specific)

2. CORPORATE/INTERNAL INFRASTRUCTURE:
   - *.corp.{company}.com (corporate networks)
   - Internal staging/production systems (e.g., productioncore.clari.io, gateway-staging.clari.com)
   - Internal dashboards (e.g., goldilocks.*.clari.io)
   - Private Git servers (e.g., git.corp.adobe.com, code.byted.org)
   - Custom ports on private domains (e.g., hisglobal.net:2226)

3. INVALID/BROKEN URL PATTERNS:
   - GitHub pull/new/* (these are creation URLs, not viewable content)
   - URLs with session tokens or temporary parameters
   - Malformed URLs with invalid characters
   - API endpoints expecting POST/PUT/DELETE requests

VALIDATION CHECKLIST - Only proceed if ALL are true:
- URL uses http:// or https:// protocol
- URL doesn't contain localhost, 127.0.0.1, or private IP ranges
- URL was explicitly provided by the user

PERFORMANCE TIP: When the user provides multiple URLs, make parallel FetchUrl calls in a single response.

DO NOT use this tool for:
- URLs not explicitly provided by the user${hasTool(context, "WebSearch") ? "\n- Web searching. Use WebSearch instead." : ""}
- Any URL matching the failure patterns above

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`url\` | \`string\` | yes | The URL to scrape content from |`.trim();
}
