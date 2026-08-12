import { type BrowserEnv, loadBrowserEnv } from "../../config/env.ts";

export interface BrowserDevtoolsTarget {
	id: string;
	type: string;
	title?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export interface BrowserHarnessSessionOptions {
	httpUrl?: string;
	webSocketUrl?: string;
	env?: BrowserEnv;
	fetch?: typeof fetch;
	webSocketFactory?: (url: string) => WebSocket;
	routePageCommands?: boolean;
}

export interface BrowserHarnessClient {
	call<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<T>;
	close?(): void;
}

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
}

interface CdpResponse {
	id?: number;
	result?: unknown;
	error?: { message?: string; data?: unknown };
}

interface VersionResult {
	webSocketDebuggerUrl?: string;
}

interface GetTargetsResult {
	targetInfos?: Array<{
		targetId?: string;
		type?: string;
		url?: string;
	}>;
}

interface CreateTargetResult {
	targetId?: string;
}

interface AttachToTargetResult {
	sessionId?: string;
}

const DEFAULT_HTTP_URL = "http://127.0.0.1:9222";

export class BrowserHarnessSession implements BrowserHarnessClient {
	private readonly httpUrl: string;
	private readonly explicitWebSocketUrl?: string;
	private readonly fetchImpl: typeof fetch;
	private readonly webSocketFactory: (url: string) => WebSocket;
	private readonly routePageCommands: boolean;
	private socket: WebSocket | null = null;
	private openPromise: Promise<void> | null = null;
	private pageSessionId: string | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingCall>();

	constructor(options: BrowserHarnessSessionOptions = {}) {
		const env = options.env ?? loadBrowserEnv();
		this.httpUrl = trimTrailingSlash(
			options.httpUrl ?? env.browserCdpUrl ?? DEFAULT_HTTP_URL,
		);
		this.explicitWebSocketUrl = options.webSocketUrl ?? env.browserWsUrl;
		this.fetchImpl = options.fetch ?? fetch;
		this.webSocketFactory =
			options.webSocketFactory ?? ((url) => new WebSocket(url));
		this.routePageCommands = options.routePageCommands ?? false;
	}

	async listPageTargets(
		signal?: AbortSignal,
	): Promise<BrowserDevtoolsTarget[]> {
		const response = await this.fetchImpl(`${this.httpUrl}/json/list`, {
			signal,
		});
		if (!response.ok) {
			throw new Error(
				`Chrome DevTools target list failed with HTTP ${response.status}`,
			);
		}
		const targets = await response.json();
		if (!Array.isArray(targets)) return [];
		return targets
			.map(parseTarget)
			.filter((target): target is BrowserDevtoolsTarget => target !== null)
			.filter(isUsablePageTarget);
	}

	async connect(signal?: AbortSignal): Promise<void> {
		if (this.socket?.readyState === WebSocket.OPEN) return;
		if (this.openPromise) return this.openPromise;
		this.openPromise = this.open(signal);
		try {
			await this.openPromise;
		} finally {
			this.openPromise = null;
		}
	}

	close(): void {
		const socket = this.socket;
		this.socket = null;
		this.pageSessionId = null;
		this.rejectPending("Browser CDP socket closed");
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			socket.close();
		}
	}

	async call<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
	): Promise<T> {
		await this.connect(signal);
		const sessionId =
			this.routePageCommands && isPageCommand(method)
				? await this.ensurePageSession(signal)
				: undefined;
		try {
			return await this.callRaw<T>(method, params, signal, sessionId);
		} catch (err) {
			if (!sessionId || !isStaleSessionError(err)) throw err;
			this.pageSessionId = null;
			return await this.callRaw<T>(
				method,
				params,
				signal,
				await this.ensurePageSession(signal),
			);
		}
	}

	private async open(signal?: AbortSignal): Promise<void> {
		const webSocketUrl =
			this.explicitWebSocketUrl ?? (await this.findBrowserWebSocketUrl(signal));
		const socket = this.webSocketFactory(webSocketUrl);
		this.socket = socket;

		await new Promise<void>((resolve, reject) => {
			const abort = (): void => {
				socket.close();
				reject(new Error("aborted"));
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			socket.addEventListener(
				"open",
				() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				},
				{ once: true },
			);
			socket.addEventListener(
				"error",
				() => {
					signal?.removeEventListener("abort", abort);
					reject(
						new Error(
							"Could not connect to Chrome DevTools. Start Chrome with remote debugging enabled.",
						),
					);
				},
				{ once: true },
			);
			socket.addEventListener("message", (event) => {
				this.handleMessage(String(event.data));
			});
			socket.addEventListener("close", () => {
				this.rejectPending("Browser CDP socket closed");
				if (this.socket === socket) this.socket = null;
			});
		});
	}

	private async findBrowserWebSocketUrl(signal?: AbortSignal): Promise<string> {
		const version = await this.fetchVersion(signal);
		if (version.webSocketDebuggerUrl) return version.webSocketDebuggerUrl;
		const targets = await this.listPageTargets(signal);
		const target = targets.find((item) => item.webSocketDebuggerUrl);
		if (!target?.webSocketDebuggerUrl) {
			throw new Error(
				`No debuggable browser page found at ${this.httpUrl}. Start Chrome with --remote-debugging-port=9222 and open a page.`,
			);
		}
		return target.webSocketDebuggerUrl;
	}

	private async fetchVersion(signal?: AbortSignal): Promise<VersionResult> {
		const response = await this.fetchImpl(`${this.httpUrl}/json/version`, {
			signal,
		});
		if (!response.ok) return {};
		const raw = await response.json();
		if (!raw || typeof raw !== "object") return {};
		const value = (raw as Record<string, unknown>).webSocketDebuggerUrl;
		return typeof value === "string" ? { webSocketDebuggerUrl: value } : {};
	}

	private async ensurePageSession(signal?: AbortSignal): Promise<string> {
		if (this.pageSessionId) return this.pageSessionId;
		const targets = await this.callRaw<GetTargetsResult>(
			"Target.getTargets",
			{},
			signal,
		);
		let targetId = targets.targetInfos
			?.filter((target) => target.type === "page")
			.find((target) => isUsableTargetUrl(target.url))?.targetId;
		if (!targetId) {
			const created = await this.callRaw<CreateTargetResult>(
				"Target.createTarget",
				{ url: "about:blank" },
				signal,
			);
			targetId = created.targetId;
		}
		if (!targetId) throw new Error("Could not create browser page target");
		const attached = await this.callRaw<AttachToTargetResult>(
			"Target.attachToTarget",
			{ targetId, flatten: true },
			signal,
		);
		if (!attached.sessionId) {
			throw new Error("Could not attach to browser page target");
		}
		this.pageSessionId = attached.sessionId;
		return attached.sessionId;
	}

	private async callRaw<T = unknown>(
		method: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
		sessionId?: string,
	): Promise<T> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			throw new Error("Browser CDP socket is not connected");
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ id, method, params, sessionId });
		return await new Promise<T>((resolve, reject) => {
			const abort = (): void => {
				this.pending.delete(id);
				reject(new Error("aborted"));
			};
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			this.pending.set(id, {
				resolve: (value) => {
					signal?.removeEventListener("abort", abort);
					resolve(value as T);
				},
				reject: (err) => {
					signal?.removeEventListener("abort", abort);
					reject(err);
				},
			});
			socket.send(payload);
		});
	}

	private handleMessage(raw: string): void {
		let message: CdpResponse;
		try {
			message = JSON.parse(raw) as CdpResponse;
		} catch {
			return;
		}
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) {
			pending.reject(
				new Error(
					`CDP call failed: ${message.error.message ?? JSON.stringify(message.error)}`,
				),
			);
			return;
		}
		pending.resolve(message.result);
	}

	private rejectPending(message: string): void {
		for (const [id, pending] of this.pending) {
			this.pending.delete(id);
			pending.reject(new Error(message));
		}
	}
}

function parseTarget(value: unknown): BrowserDevtoolsTarget | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || typeof raw.type !== "string") return null;
	return {
		id: raw.id,
		type: raw.type,
		title: typeof raw.title === "string" ? raw.title : undefined,
		url: typeof raw.url === "string" ? raw.url : undefined,
		webSocketDebuggerUrl:
			typeof raw.webSocketDebuggerUrl === "string"
				? raw.webSocketDebuggerUrl
				: undefined,
	};
}

export function isUsablePageTarget(target: BrowserDevtoolsTarget): boolean {
	if (target.type !== "page") return false;
	return isUsableTargetUrl(target.url);
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function isUsableTargetUrl(value: string | undefined): boolean {
	const url = value ?? "";
	return !url.startsWith("chrome://") && !url.startsWith("devtools://");
}

function isPageCommand(method: string): boolean {
	const domain = method.split(".", 1)[0];
	return domain !== "Browser" && domain !== "Target";
}

function isStaleSessionError(err: unknown): boolean {
	return (
		err instanceof Error &&
		err.message.includes("Session with given id not found")
	);
}
