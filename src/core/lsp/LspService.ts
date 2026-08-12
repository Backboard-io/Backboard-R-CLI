import { isAbsolute, resolve } from "node:path";
import type { Diagnostic } from "vscode-languageserver-types";
import { isLspServerUnavailableError } from "./errors.ts";
import { type LspFlags, resolveLspFlags } from "./flags.ts";
import { LspClient } from "./LspClient.ts";
import {
	BUILTIN_SERVERS,
	type ServerContext,
	type ServerInfo,
	serverExtension,
} from "./servers.ts";

export interface LspServiceOptions {
	directory: string;
	flags?: LspFlags;
	servers?: ServerInfo[];
	onWarning?: (message: string) => void;
}

export interface LspStatus {
	id: string;
	root: string;
	status: "connected" | "error";
	message?: string;
}

interface BrokenServer {
	id: string;
	root: string;
	message: string;
	warned: boolean;
}

/**
 * Coordinates language-server clients for a workspace. Clients are spawned
 * lazily on first touch of a matching file, cached per (root, server), and
 * de-duped across concurrent spawns. Servers whose binaries are missing get
 * marked broken and skipped silently. All public methods are best-effort and
 * never throw into the caller's edit loop.
 */
export class LspService {
	private readonly directory: string;
	private flags: LspFlags;
	private readonly servers: ServerInfo[];
	private readonly onWarning?: (message: string) => void;

	private readonly clients: LspClient[] = [];
	private readonly broken = new Map<string, BrokenServer>();
	private readonly spawning = new Map<string, Promise<LspClient | undefined>>();

	constructor(options: LspServiceOptions) {
		this.directory = options.directory;
		this.flags = options.flags ?? resolveLspFlags();
		this.servers = options.servers ?? BUILTIN_SERVERS;
		this.onWarning = options.onWarning;
	}

	get enabled(): boolean {
		return this.flags.enabled;
	}

	async setEnabled(enabled: boolean): Promise<void> {
		if (this.flags.enabled === enabled) return;
		this.flags = { ...this.flags, enabled };
		if (!enabled) {
			this.broken.clear();
			this.spawning.clear();
			await this.shutdown();
		}
	}

	async toggleEnabled(): Promise<boolean> {
		const enabled = !this.flags.enabled;
		await this.setEnabled(enabled);
		return enabled;
	}

	private get serverContext(): ServerContext {
		return { directory: this.directory, flags: this.flags };
	}

	/** Servers that declare support for this file's extension. */
	private matchingServers(file: string): ServerInfo[] {
		const ext = serverExtension(file);
		return this.servers.filter(
			(server) =>
				server.extensions.length === 0 || server.extensions.includes(ext),
		);
	}

	private async clientsFor(file: string): Promise<LspClient[]> {
		if (!this.flags.enabled) return [];
		const ctx = this.serverContext;
		const result: LspClient[] = [];

		for (const server of this.matchingServers(file)) {
			const root = await server.root(file, ctx).catch(() => undefined);
			if (!root) continue;
			const key = `${root}::${server.id}`;
			if (this.broken.has(key)) continue;

			const existing = this.clients.find(
				(client) => client.root === root && client.serverID === server.id,
			);
			if (existing) {
				result.push(existing);
				continue;
			}

			const inflight = this.spawning.get(key);
			if (inflight) {
				const client = await inflight;
				if (client) result.push(client);
				continue;
			}

			const task = this.spawnClient(server, root, key);
			this.spawning.set(key, task);
			task.finally(() => {
				if (this.spawning.get(key) === task) this.spawning.delete(key);
			});
			const client = await task;
			if (client) result.push(client);
		}

		return result;
	}

	private async spawnClient(
		server: ServerInfo,
		root: string,
		key: string,
	): Promise<LspClient | undefined> {
		try {
			const handle = await server.spawn(root, this.serverContext);
			if (!handle) {
				this.markBroken(
					server.id,
					root,
					key,
					"server did not return a process",
				);
				return undefined;
			}
			const client = await LspClient.create({
				serverID: server.id,
				handle,
				root,
				directory: this.directory,
			});
			if (!this.flags.enabled) {
				await client.shutdown().catch(() => {});
				return undefined;
			}
			this.clients.push(client);
			return client;
		} catch (error) {
			const message = isLspServerUnavailableError(error)
				? error.message
				: error instanceof Error && error.message.trim()
					? error.message
					: "failed to start or initialize language server";
			this.markBroken(server.id, root, key, message);
			return undefined;
		}
	}

	private markBroken(
		id: string,
		root: string,
		key: string,
		message: string,
	): void {
		const existing = this.broken.get(key);
		if (existing) return;
		const broken: BrokenServer = { id, root, message, warned: false };
		this.broken.set(key, broken);
		this.emitBrokenWarning(broken);
	}

	private emitBrokenWarning(broken: BrokenServer): void {
		if (broken.warned) return;
		broken.warned = true;
		this.onWarning?.(
			`LSP server '${broken.id}' unavailable for ${broken.root}: ${broken.message}.`,
		);
	}

	private normalize(path: string): string {
		return isAbsolute(path) ? path : resolve(this.directory, path);
	}

	/**
	 * Open/refresh a file across its servers. When `waitForDiagnostics` is true,
	 * waits (briefly, bounded) for the resulting diagnostics push so a following
	 * `diagnostics()` call sees fresh data.
	 */
	async touchFile(
		file: string,
		options: { waitForDiagnostics?: boolean } = {},
	): Promise<void> {
		if (!this.flags.enabled) return;
		try {
			const clients = await this.clientsFor(file);
			await Promise.all(
				clients.map(async (client) => {
					const after = Date.now();
					await client.open(file);
					if (options.waitForDiagnostics) {
						await client.waitForDiagnostics({
							path: this.normalize(file),
							after,
						});
					}
				}),
			);
		} catch {
			// best effort: diagnostics are advisory, never fatal to an edit
		}
	}

	/** Merge the latest diagnostics from every live client, keyed by path. */
	diagnostics(): Record<string, Diagnostic[]> {
		const result: Record<string, Diagnostic[]> = {};
		for (const client of this.clients) {
			for (const [path, diags] of client.diagnostics.entries()) {
				const existing = result[path] ?? [];
				existing.push(...diags);
				result[path] = existing;
			}
		}
		return result;
	}

	/** Diagnostics for a single file (absolute or relative to the workspace). */
	diagnosticsForFile(file: string): Diagnostic[] {
		const path = this.normalize(file);
		const all = this.diagnostics();
		return all[path] ?? [];
	}

	status(): LspStatus[] {
		return [
			...this.clients.map((client) => ({
				id: client.serverID,
				root: client.root,
				status: "connected" as const,
			})),
			...Array.from(this.broken.values()).map((server) => ({
				id: server.id,
				root: server.root,
				status: "error" as const,
				message: server.message,
			})),
		];
	}

	async shutdown(): Promise<void> {
		await Promise.all(
			this.clients.map((client) => client.shutdown().catch(() => {})),
		);
		this.clients.length = 0;
	}
}
