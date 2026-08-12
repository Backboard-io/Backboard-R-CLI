import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
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
import {
	FETCH_URL_MAX_REDIRECTS,
	FETCH_URL_MAX_RESPONSE_BYTES,
	FETCH_URL_MAX_TEXT,
	FETCH_URL_PRIVATE_ADDRESSES,
	FETCH_URL_PRIVATE_NETWORK_ERROR,
} from "./FetchUrlTool.constants.ts";

const schema = z.object({
	url: z.string().url().describe("The URL to scrape content from"),
});

type Input = z.infer<typeof schema>;

interface Output {
	url: string;
	status: number;
	text: string;
}

export class FetchUrlTool extends Tool<Input, Output> {
	readonly name = "FetchUrl";
	readonly inputSchema = schema;

	override prompt(context: PromptContext = {}): string {
		return getToolPrompt(this.name, context);
	}

	override isReadOnly(): boolean {
		return false;
	}

	override permissionContent(input: Input): string {
		return input.url;
	}

	// Not read-only (a crafted URL can exfiltrate), but still a read: auto
	// trusts it, manual keeps the prompt, deny rules can block domains.
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
		const url = new URL(input.url);
		await assertAllowedFetchUrl(url);

		const res = await fetchAllowedUrl(url, ctx.signal);
		const { text: raw } = await readLimitedResponseText(
			res,
			FETCH_URL_MAX_RESPONSE_BYTES,
		);
		const contentType = res.headers.get("content-type") ?? "";
		const text = contentType.includes("html") ? stripHtml(raw) : raw;

		const trimmed =
			text.length > FETCH_URL_MAX_TEXT
				? text.slice(0, FETCH_URL_MAX_TEXT)
				: text;
		return ok(
			{ url: input.url, status: res.status, text: trimmed },
			trimmed,
			`HTTP ${res.status} · fetched response`,
		);
	}
}

async function fetchAllowedUrl(
	url: URL,
	signal: AbortSignal,
): Promise<Response> {
	let current = url;
	for (
		let redirects = 0;
		redirects <= FETCH_URL_MAX_REDIRECTS;
		redirects += 1
	) {
		await assertAllowedFetchUrl(current);
		const res = await fetch(current, {
			signal,
			redirect: "manual",
			headers: {
				"User-Agent": `${APP_PACKAGE_NAME}/${APP_VERSION} (+https://backboard.io)`,
			},
		});
		if (!isRedirectResponse(res)) return res;

		const location = res.headers.get("location");
		if (!location) return res;
		current = new URL(location, current);
	}
	throw new Error(
		`FetchUrl stopped after ${FETCH_URL_MAX_REDIRECTS} redirects.`,
	);
}

async function assertAllowedFetchUrl(url: URL): Promise<void> {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("FetchUrl only supports http and https URLs.");
	}

	const hostname = normalizedHostname(url.hostname);
	if (isBlockedHostname(hostname)) {
		throw new Error(FETCH_URL_PRIVATE_NETWORK_ERROR);
	}

	const ipVersion = isIP(hostname);
	if (ipVersion) {
		if (isPrivateAddress(hostname, ipVersion)) {
			throw new Error(FETCH_URL_PRIVATE_NETWORK_ERROR);
		}
		return;
	}

	const addresses = await lookup(hostname, { all: true, verbatim: true });
	if (
		addresses.some(({ address, family }) => isPrivateAddress(address, family))
	) {
		throw new Error(FETCH_URL_PRIVATE_NETWORK_ERROR);
	}
}

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isBlockedHostname(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname.endsWith(".local") ||
		hostname.endsWith(".internal")
	);
}

function isPrivateAddress(address: string, family: number): boolean {
	const normalized = normalizedHostname(address);
	const embeddedIPv4 = normalized.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (
		embeddedIPv4?.[1] &&
		FETCH_URL_PRIVATE_ADDRESSES.check(embeddedIPv4[1], "ipv4")
	) {
		return true;
	}
	if (family === 4)
		return FETCH_URL_PRIVATE_ADDRESSES.check(normalized, "ipv4");
	if (family === 6)
		return FETCH_URL_PRIVATE_ADDRESSES.check(normalized, "ipv6");
	return false;
}

function isRedirectResponse(res: Response): boolean {
	return res.status >= 300 && res.status < 400;
}

function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+\n/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}
