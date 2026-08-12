import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { RequestListener, Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type {
	OAuthClientProvider,
	OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { APP_DISPLAY_NAME } from "../../config/branding.ts";
import { qUserConfigDir } from "../../config/paths.ts";
import {
	isNodeError,
	listenOnLoopback,
	openDefaultBrowser,
} from "../oauth/LoopbackOAuth.ts";

const AUTH_DIR_NAME = "mcp-oauth";
const CALLBACK_PORT_BASE = 7810;
const CALLBACK_PORT_RANGE = 50;
const CALLBACK_FALLBACK_PORT_BASE = 49_152;
const CALLBACK_FALLBACK_PORT_RANGE = 16_384;
const CALLBACK_FALLBACK_PORT_ATTEMPTS = 100;
const CALLBACK_PATH = "/oauth/callback";

interface StoredOAuthState {
	clientInformation?: OAuthClientInformationMixed;
	clientMetadataKey?: string;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
}

interface CallbackServer {
	close(callback?: (err?: Error) => void): unknown;
}

type CallbackServerFactory = (
	port: number,
	handler: RequestListener,
) => Promise<CallbackServer>;
type BrowserOpener = (url: URL) => Promise<void>;

export interface McpOAuthProviderOptions {
	listenCallbackServer?: CallbackServerFactory;
	openBrowser?: BrowserOpener;
	stateDir?: string;
}

export class McpOAuthProvider implements OAuthClientProvider {
	private readonly statePath: string;
	private readonly listenCallbackServerFn: CallbackServerFactory;
	private readonly openBrowserFn: BrowserOpener;
	private redirect: string;
	private metadata: OAuthClientMetadata;
	private readonly expectedState = randomBytes(16).toString("base64url");
	private callbackPromise: Promise<string> | null = null;
	private callbackServer: CallbackServer | null = null;

	constructor(
		private readonly serverName: string,
		private readonly interactive: boolean,
		options: McpOAuthProviderOptions = {},
	) {
		this.redirect = callbackRedirectForPort(preferredCallbackPort(serverName));
		this.listenCallbackServerFn =
			options.listenCallbackServer ?? listenOnLocalhost;
		this.openBrowserFn = options.openBrowser ?? openDefaultBrowser;
		this.statePath = path.join(
			options.stateDir ?? path.join(qUserConfigDir(), AUTH_DIR_NAME),
			`${safeFileName(serverName)}.json`,
		);
		this.metadata = clientMetadataForRedirect(this.redirect);
	}

	get redirectUrl(): string {
		return this.redirect;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.metadata;
	}

	state(): string {
		return this.expectedState;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		if (this.interactive) await this.ensureCallbackServer();
		const state = await this.load();
		if (!state.clientInformation) return undefined;
		if (state.clientMetadataKey !== this.clientMetadataKey()) {
			delete state.clientInformation;
			delete state.tokens;
			await this.save(state);
			return undefined;
		}
		return state.clientInformation;
	}

	async saveClientInformation(
		clientInformation: OAuthClientInformationMixed,
	): Promise<void> {
		const state = await this.load();
		state.clientInformation = clientInformation;
		state.clientMetadataKey = this.clientMetadataKey();
		await this.save(state);
	}

	async tokens(): Promise<OAuthTokens | undefined> {
		return (await this.load()).tokens;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const state = await this.load();
		state.tokens = tokens;
		await this.save(state);
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		if (!this.interactive) {
			throw new McpAuthenticationRequiredError(this.serverName);
		}
		await this.ensureCallbackServer();
		try {
			await this.openBrowserFn(authorizationUrl);
		} catch (err) {
			this.resetCallbackServer();
			throw err;
		}
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		const state = await this.load();
		state.codeVerifier = codeVerifier;
		await this.save(state);
	}

	async codeVerifier(): Promise<string> {
		const codeVerifier = (await this.load()).codeVerifier;
		if (!codeVerifier) throw new Error("No MCP OAuth code verifier saved.");
		return codeVerifier;
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		const state = await this.load();
		state.discoveryState = discoveryState;
		await this.save(state);
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.load()).discoveryState;
	}

	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		const state = await this.load();
		if (scope === "all" || scope === "client") {
			delete state.clientInformation;
			delete state.clientMetadataKey;
		}
		if (scope === "all" || scope === "tokens") {
			delete state.tokens;
		}
		if (scope === "all" || scope === "verifier") {
			delete state.codeVerifier;
		}
		if (scope === "all" || scope === "discovery") {
			delete state.discoveryState;
		}
		await this.save(state);
	}

	async waitForAuthorizationCode(
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<string> {
		if (!this.interactive) {
			throw new McpAuthenticationRequiredError(this.serverName);
		}
		await this.ensureCallbackServer();
		try {
			return await withTimeout(this.callbackPromise ?? Promise.reject(), {
				signal,
				timeoutMs,
				onTimeout: () =>
					new Error(
						`Timed out waiting for MCP authorization for ${this.serverName}.`,
					),
			});
		} finally {
			this.resetCallbackServer();
		}
	}

	private async ensureCallbackServer(): Promise<void> {
		if (this.callbackPromise) return;

		let resolveCode: (code: string) => void = () => undefined;
		let rejectCode: (err: Error) => void = () => undefined;
		this.callbackPromise = new Promise<string>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});

		for (const port of callbackPorts(this.serverName)) {
			const redirect = callbackRedirectForPort(port);
			try {
				const server = await this.listenCallbackServer(
					port,
					resolveCode,
					rejectCode,
				);
				this.redirect = redirect;
				this.metadata = clientMetadataForRedirect(redirect);
				this.callbackServer = server;
				return;
			} catch (err) {
				if (isNodeError(err) && err.code === "EADDRINUSE") continue;
				this.callbackPromise = null;
				rejectCode(err instanceof Error ? err : new Error(String(err)));
				throw err;
			}
		}

		const err = new Error(
			`No available MCP OAuth callback ports for ${this.serverName}.`,
		);
		this.callbackPromise = null;
		rejectCode(err);
		throw err;
	}

	private async listenCallbackServer(
		port: number,
		resolveCode: (code: string) => void,
		rejectCode: (err: Error) => void,
	): Promise<CallbackServer> {
		return await this.listenCallbackServerFn(port, (req, res) => {
			const callback = new URL(req.url ?? "/", "http://localhost");
			if (callback.pathname !== CALLBACK_PATH) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}

			const error = callback.searchParams.get("error");
			const code = callback.searchParams.get("code");
			const state = callback.searchParams.get("state");
			if (error) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(callbackHtml("Authorization failed", error));
				rejectCode(new Error(`MCP OAuth failed: ${error}`));
				this.closeCallbackServer();
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(callbackHtml("Authorization failed", "Missing code."));
				rejectCode(new Error("MCP OAuth callback did not include a code."));
				this.closeCallbackServer();
				return;
			}
			if (state !== this.expectedState) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(callbackHtml("Authorization failed", "State mismatch."));
				rejectCode(new Error("MCP OAuth state mismatch."));
				this.closeCallbackServer();
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(
				callbackHtml(
					"Authorization complete",
					`You can close this window and return to ${APP_DISPLAY_NAME}.`,
				),
			);
			resolveCode(code);
			this.closeCallbackServer();
		});
	}

	closeCallbackServer(): void {
		const server = this.callbackServer;
		this.callbackServer = null;
		server?.close();
	}

	private resetCallbackServer(): void {
		this.callbackPromise = null;
		this.closeCallbackServer();
	}

	private async load(): Promise<StoredOAuthState> {
		try {
			const raw = await readFile(this.statePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			return isStoredOAuthState(parsed) ? parsed : {};
		} catch (err) {
			if (isNodeError(err) && err.code === "ENOENT") return {};
			throw err;
		}
	}

	private async save(state: StoredOAuthState): Promise<void> {
		await mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
		await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, {
			mode: 0o600,
		});
		if (os.platform() !== "win32") {
			await chmod(this.statePath, 0o600).catch(() => undefined);
		}
	}

	private clientMetadataKey(): string {
		const metadata = this.clientMetadata;
		return JSON.stringify({
			client_name: metadata.client_name,
			redirect_uris: metadata.redirect_uris,
			grant_types: metadata.grant_types,
			response_types: metadata.response_types,
		});
	}
}

function clientMetadataForRedirect(redirect: string): OAuthClientMetadata {
	return {
		client_name: APP_DISPLAY_NAME,
		redirect_uris: [redirect],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
	};
}

function preferredCallbackPort(serverName: string): number {
	return CALLBACK_PORT_BASE + (hash(serverName) % CALLBACK_PORT_RANGE);
}

function callbackPorts(serverName: string): number[] {
	const preferredOffset = hash(serverName) % CALLBACK_PORT_RANGE;
	const primary = Array.from(
		{ length: CALLBACK_PORT_RANGE },
		(_, index) =>
			CALLBACK_PORT_BASE + ((preferredOffset + index) % CALLBACK_PORT_RANGE),
	);
	const fallbackOffset =
		hash(`${serverName}:fallback`) % CALLBACK_FALLBACK_PORT_RANGE;
	const fallback = Array.from(
		{ length: CALLBACK_FALLBACK_PORT_ATTEMPTS },
		(_, index) =>
			CALLBACK_FALLBACK_PORT_BASE +
			((fallbackOffset + index) % CALLBACK_FALLBACK_PORT_RANGE),
	);
	return [...new Set([...primary, ...fallback])];
}

function callbackRedirectForPort(port: number): string {
	// Vercel rejects 127.0.0.1 loopback redirect URIs, but accepts localhost.
	return `http://localhost:${port}${CALLBACK_PATH}`;
}

async function listenOnLocalhost(
	port: number,
	handler: RequestListener,
): Promise<Server> {
	return await listenOnLoopback("localhost", port, handler);
}

export class McpAuthenticationRequiredError extends Error {
	constructor(serverName: string) {
		super(`MCP server '${serverName}' requires authentication.`);
		this.name = "McpAuthenticationRequiredError";
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	options: {
		signal: AbortSignal;
		timeoutMs: number;
		onTimeout: () => Error;
	},
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return await new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(new Error("MCP authorization cancelled."));
		options.signal.addEventListener("abort", abort, { once: true });
		timeout = setTimeout(() => reject(options.onTimeout()), options.timeoutMs);
		promise.then(resolve, reject).finally(() => {
			options.signal.removeEventListener("abort", abort);
			if (timeout) clearTimeout(timeout);
		});
	});
}

function callbackHtml(title: string, message: string): string {
	return `<!doctype html><html><head><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function safeFileName(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "server";
}

function hash(value: string): number {
	let result = 0;
	for (const char of value) {
		result = (result * 31 + char.charCodeAt(0)) >>> 0;
	}
	return result;
}

function isStoredOAuthState(value: unknown): value is StoredOAuthState {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
