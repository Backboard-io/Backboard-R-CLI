import {
	definePrompt,
	hasTool,
	type PromptContext,
	type PromptModule,
} from "../../../PromptModule.ts";

export const fetchUrl: PromptModule = definePrompt(
	buildFetchUrlPrompt(),
	buildFetchUrlPrompt,
);

function buildFetchUrlPrompt(context: PromptContext = {}): string {
	return `Scrape content from a user-provided URL and return it as markdown. Works for generic web pages and specific integration URLs.

CRITICAL: before calling this, check whether the URL will fail.

URLS THAT ALWAYS FAIL - DO NOT FETCH:

1. LOCAL/PRIVATE NETWORK URLs:
   - http://localhost:* (any port)
   - http://127.0.0.1:* or http://[::1]:*
   - http://0.0.0.0:*
   - http://10.*.*.* (private network)
   - http://172.16-31.*.* (private network)
   - http://192.168.*.* (private network)
   - http://169.254.*.* (link-local)
   - *.local, *.internal domains
   - http://*.lvh.me:* (localhost aliases)

2. NON-HTTP PROTOCOLS:
   - file:/// (local file system)
   - ssh://, ftp://, powershell://
   - view-source: (browser-specific)

3. CORPORATE/INTERNAL INFRASTRUCTURE:
   - *.corp.{company}.com (corporate networks)
   - Internal staging/production systems (e.g., productioncore.clari.io, gateway-staging.clari.com)
   - Internal dashboards (e.g., goldilocks.*.clari.io)
   - Private Git servers (e.g., git.corp.adobe.com, code.byted.org)
   - Custom ports on private domains (e.g., hisglobal.net:2226)

4. INVALID/BROKEN URL PATTERNS:
   - GitHub pull/new/* (these are creation URLs, not viewable content)
   - URLs with session tokens or temporary parameters
   - Malformed URLs with invalid characters
   - API endpoints expecting POST/PUT/DELETE requests

VALIDATION CHECKLIST - proceed only if ALL are true:
- The URL uses http:// or https://.
- The URL is not localhost, 127.0.0.1, or a private IP range.
- The user provided the URL explicitly.

PERFORMANCE TIP: when the user gives several URLs, fetch them with parallel calls in one response.

Do NOT use this tool for:
- URLs the user did not explicitly provide${webSearchLine(context)}
- Any URL matching the failure patterns above

### Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| \`url\` | \`string\` | yes | The URL to scrape content from |`.trim();
}

function webSearchLine(context: PromptContext): string {
	return hasTool(context, "WebSearch")
		? "\n- Web searching (use the web_search tool instead)"
		: "";
}
