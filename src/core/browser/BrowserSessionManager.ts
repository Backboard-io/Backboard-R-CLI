import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserEnv, loadBrowserEnv } from "../../config/env.ts";
import {
	type BrowserExecutableOptions,
	findBrowserExecutable,
} from "./BrowserExecutable.ts";
import { BrowserHarnessPlatform } from "./BrowserHarnessPlatform.ts";
import { BrowserHarnessSession } from "./BrowserHarnessSession.ts";

export interface BrowserSessionManagerOptions {
	env?: BrowserEnv;
	fetch?: typeof fetch;
	executable?: BrowserExecutableOptions;
	spawn?: typeof Bun.spawn;
}

const DEFAULT_HTTP_URL = "http://127.0.0.1:9222";

export class BrowserSessionManager {
	private readonly env: BrowserEnv;
	private readonly fetchImpl: typeof fetch;
	private readonly spawnImpl: typeof Bun.spawn;
	private readonly executableOptions?: BrowserExecutableOptions;
	private platform: BrowserHarnessPlatform | null = null;
	private session: BrowserHarnessSession | null = null;
	private launched: {
		proc: ReturnType<typeof Bun.spawn>;
		profileDir: string;
	} | null = null;

	constructor(options: BrowserSessionManagerOptions = {}) {
		this.env = options.env ?? loadBrowserEnv();
		this.fetchImpl = options.fetch ?? fetch;
		this.spawnImpl = options.spawn ?? Bun.spawn;
		this.executableOptions = options.executable;
	}

	async getPlatform(signal?: AbortSignal): Promise<BrowserHarnessPlatform> {
		if (this.platform) return this.platform;

		const existing = await this.discoverExistingWebSocketUrl(signal);
		if (existing.explicit && !existing.webSocketUrl) {
			throw new Error("Configured Browser DevTools endpoint is not usable.");
		}
		if (existing.webSocketUrl) {
			const platform = await this.platformFromWebSocket(
				existing.webSocketUrl,
				signal,
			);
			if (platform) return platform;
			if (existing.explicit) {
				throw new Error("Configured Browser DevTools endpoint is not usable.");
			}
		}

		return await this.launch(signal);
	}

	async dispose(): Promise<void> {
		const launched = this.launched;
		this.session?.close();
		this.session = null;
		this.launched = null;
		this.platform = null;
		if (!launched) return;
		launched.proc.kill();
		await Promise.race([
			launched.proc.exited.catch(() => undefined),
			delay(1_000),
		]);
		await rm(launched.profileDir, { recursive: true, force: true });
	}

	private async discoverExistingWebSocketUrl(
		signal?: AbortSignal,
	): Promise<{ webSocketUrl: string | null; explicit: boolean }> {
		const explicitWs = this.env.browserWsUrl;
		if (explicitWs) return { webSocketUrl: explicitWs, explicit: true };

		const explicitHttp = this.env.browserCdpUrl;
		if (explicitHttp) {
			const ws = await this.fetchBrowserWebSocketUrl(explicitHttp, signal);
			return { webSocketUrl: ws, explicit: true };
		}

		const defaultWs = await this.fetchBrowserWebSocketUrl(
			DEFAULT_HTTP_URL,
			signal,
		);
		if (defaultWs) return { webSocketUrl: defaultWs, explicit: false };

		const webSocketUrl = await this.readDevToolsActivePort(
			join(
				this.env.home ?? "",
				"Library",
				"Application Support",
				"Google",
				"Chrome",
			),
		);
		return { webSocketUrl, explicit: false };
	}

	private async platformFromWebSocket(
		webSocketUrl: string,
		signal?: AbortSignal,
	): Promise<BrowserHarnessPlatform | null> {
		const session = new BrowserHarnessSession({
			webSocketUrl,
			routePageCommands: true,
			fetch: this.fetchImpl,
		});
		try {
			await session.connect(signal);
			const platform = new BrowserHarnessPlatform(session);
			this.session = session;
			this.platform = platform;
			return platform;
		} catch {
			return null;
		}
	}

	private async launch(signal?: AbortSignal): Promise<BrowserHarnessPlatform> {
		const executable = await findBrowserExecutable({
			...this.executableOptions,
			env: this.env,
		});
		const profileDir = await mkdtemp(join(tmpdir(), "browser-profile-"));
		const proc = this.spawnImpl(
			[
				executable,
				"--remote-debugging-port=0",
				`--user-data-dir=${profileDir}`,
				"--no-first-run",
				"--no-default-browser-check",
				"about:blank",
			],
			{ stdout: "ignore", stderr: "ignore" },
		);
		this.launched = { proc, profileDir };
		try {
			const webSocketUrl = await this.waitForDevToolsActivePort(
				profileDir,
				signal,
			);
			const platform = await this.platformFromWebSocket(webSocketUrl, signal);
			if (!platform) {
				throw new Error("Launched browser, but could not connect to DevTools.");
			}
			return platform;
		} catch (err) {
			await this.dispose();
			throw err;
		}
	}

	private async fetchBrowserWebSocketUrl(
		httpUrl: string,
		signal?: AbortSignal,
	): Promise<string | null> {
		try {
			const response = await this.fetchImpl(
				`${trimTrailingSlash(httpUrl)}/json/version`,
				{ signal },
			);
			if (!response.ok) return null;
			const raw = await response.json();
			if (!raw || typeof raw !== "object") return null;
			const value = (raw as Record<string, unknown>).webSocketDebuggerUrl;
			return typeof value === "string" ? value : null;
		} catch {
			return null;
		}
	}

	private async waitForDevToolsActivePort(
		profileDir: string,
		signal?: AbortSignal,
	): Promise<string> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("aborted");
			const webSocketUrl = await this.readDevToolsActivePort(profileDir);
			if (webSocketUrl) return webSocketUrl;
			await delay(100);
		}
		throw new Error("Browser DevTools endpoint did not become ready.");
	}

	private async readDevToolsActivePort(
		profileDir: string,
	): Promise<string | null> {
		if (!profileDir) return null;
		try {
			const content = await readFile(
				join(profileDir, "DevToolsActivePort"),
				"utf8",
			);
			const [port, path] = content
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			if (!port || !path) return null;
			return `ws://127.0.0.1:${port}${path}`;
		} catch {
			return null;
		}
	}
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
