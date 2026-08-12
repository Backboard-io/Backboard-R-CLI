import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createMessageConnection,
	type MessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-types";
import { languageIdForPath } from "./language.ts";
import { stopServer } from "./launch.ts";
import type { ServerHandle } from "./servers.ts";

const INITIALIZE_TIMEOUT_MS = 30_000;
const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_WAIT_TIMEOUT_MS = 6_000;

const FILE_CHANGE_CHANGED = 2;

interface OpenDocument {
	version: number;
	text: string;
}

interface DiagnosticEvent {
	path: string;
	at: number;
	version?: number;
}

export interface LspClientOptions {
	serverID: string;
	handle: ServerHandle;
	root: string;
	directory: string;
}

function uriForPath(path: string): string {
	return pathToFileURL(path).href;
}

function pathForUri(uri: string): string | undefined {
	if (!uri.startsWith("file://")) return undefined;
	try {
		return fileURLToPath(uri);
	} catch {
		return undefined;
	}
}

/**
 * A single language-server connection scoped to one (root, server) pair. Owns
 * the JSON-RPC connection, the set of opened documents, and the latest pushed
 * diagnostics. Diagnostics are surfaced via `diagnostics` and awaited with
 * `waitForDiagnostics` using a short debounce + bounded timeout so the edit
 * loop never blocks for long.
 */
export class LspClient {
	private constructor(
		readonly serverID: string,
		readonly root: string,
		private readonly directory: string,
		private readonly connection: MessageConnection,
		private readonly handle: ServerHandle,
	) {}

	private readonly documents = new Map<string, OpenDocument>();
	private readonly pushed = new Map<string, Diagnostic[]>();
	private readonly lastPublishedAt = new Map<string, number>();
	private readonly listeners = new Set<(event: DiagnosticEvent) => void>();

	static async create(options: LspClientOptions): Promise<LspClient> {
		const { handle } = options;
		const connection = createMessageConnection(
			new StreamMessageReader(handle.process.stdout),
			new StreamMessageWriter(handle.process.stdin),
		);
		const client = new LspClient(
			options.serverID,
			options.root,
			options.directory,
			connection,
			handle,
		);
		client.registerHandlers();
		connection.listen();
		await client.initialize();
		return client;
	}

	private registerHandlers(): void {
		this.connection.onNotification(
			"textDocument/publishDiagnostics",
			(params: {
				uri: string;
				version?: number;
				diagnostics: Diagnostic[];
			}) => {
				const path = pathForUri(params.uri);
				if (!path) return;
				const at = Date.now();
				this.pushed.set(path, params.diagnostics ?? []);
				this.lastPublishedAt.set(path, at);
				const event: DiagnosticEvent = {
					path,
					at,
					version:
						typeof params.version === "number" ? params.version : undefined,
				};
				for (const listener of [...this.listeners]) listener(event);
			},
		);

		// Servers may request these; answer with benign defaults so they proceed.
		this.connection.onRequest("workspace/configuration", (params) => {
			const items = (params as { items?: unknown[] }).items ?? [];
			return items.map(() => this.handle.initialization ?? null);
		});
		this.connection.onRequest("window/workDoneProgress/create", () => null);
		this.connection.onRequest("client/registerCapability", () => null);
		this.connection.onRequest("client/unregisterCapability", () => null);
	}

	private async initialize(): Promise<void> {
		const init = this.connection.sendRequest("initialize", {
			processId: process.pid,
			rootUri: uriForPath(this.root),
			workspaceFolders: [{ uri: uriForPath(this.root), name: "workspace" }],
			initializationOptions: this.handle.initialization,
			capabilities: {
				textDocument: {
					synchronization: { dynamicRegistration: false },
					publishDiagnostics: { relatedInformation: true },
				},
				workspace: {
					configuration: true,
					workspaceFolders: true,
					didChangeWatchedFiles: { dynamicRegistration: false },
				},
				window: { workDoneProgress: true },
			},
		});
		await withTimeout(init, INITIALIZE_TIMEOUT_MS);
		await this.connection.sendNotification("initialized", {});
	}

	private normalize(path: string): string {
		return isAbsolute(path) ? path : resolve(this.directory, path);
	}

	/**
	 * Open or refresh a document so the server (re)computes diagnostics. Returns
	 * the document version associated with this change.
	 */
	async open(filePath: string): Promise<number> {
		const path = this.normalize(filePath);
		const text = await readFile(path, "utf8");
		const uri = uriForPath(path);
		const existing = this.documents.get(path);

		if (existing) {
			const version = existing.version + 1;
			this.documents.set(path, { version, text });
			await this.connection.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
			await this.connection.sendNotification(
				"workspace/didChangeWatchedFiles",
				{ changes: [{ uri, type: FILE_CHANGE_CHANGED }] },
			);
			return version;
		}

		this.pushed.delete(path);
		this.documents.set(path, { version: 0, text });
		await this.connection.sendNotification("textDocument/didOpen", {
			textDocument: {
				uri,
				languageId: languageIdForPath(path),
				version: 0,
				text,
			},
		});
		return 0;
	}

	/** Snapshot of the latest pushed diagnostics keyed by absolute path. */
	get diagnostics(): Map<string, Diagnostic[]> {
		return new Map(this.pushed);
	}

	/**
	 * Wait until the server publishes diagnostics for `path` (timestamped after
	 * `after`), debouncing rapid bursts. Resolves on timeout regardless so the
	 * caller is never blocked beyond the budget.
	 */
	waitForDiagnostics(request: { path: string; after: number }): Promise<void> {
		const path = this.normalize(request.path);
		return new Promise<void>((resolveWait) => {
			let debounce: ReturnType<typeof setTimeout> | undefined;
			let settled = false;

			const finish = () => {
				if (settled) return;
				settled = true;
				if (debounce) clearTimeout(debounce);
				clearTimeout(timeout);
				this.listeners.delete(listener);
				resolveWait();
			};

			const listener = (event: DiagnosticEvent) => {
				if (event.path !== path) return;
				if (event.at < request.after) return;
				if (debounce) clearTimeout(debounce);
				debounce = setTimeout(finish, DIAGNOSTICS_DEBOUNCE_MS);
			};

			const timeout = setTimeout(finish, DIAGNOSTICS_WAIT_TIMEOUT_MS);
			timeout.unref?.();
			this.listeners.add(listener);

			// If a publish for this file already landed at/after `after` (e.g. the
			// server seeded diagnostics on didOpen before this wait registered),
			// start the debounce immediately instead of blocking until timeout.
			const published = this.lastPublishedAt.get(path);
			if (published !== undefined && published >= request.after) {
				debounce = setTimeout(finish, DIAGNOSTICS_DEBOUNCE_MS);
			}
		});
	}

	async shutdown(): Promise<void> {
		try {
			await withTimeout(this.connection.sendRequest("shutdown"), 2000);
			await this.connection.sendNotification("exit");
		} catch {
			// best effort
		}
		try {
			this.connection.dispose();
		} catch {
			// already disposed
		}
		stopServer(this.handle.process);
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolvePromise, reject) => {
		const timer = setTimeout(
			() => reject(new Error("LSP request timed out")),
			ms,
		);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
