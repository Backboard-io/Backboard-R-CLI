import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import type { BinaryResolutionResult } from "./binaries.ts";
import { LspServerUnavailableError } from "./errors.ts";
import type { LspFlags } from "./flags.ts";
import {
	commandInstall,
	type LspInstallStrategy,
	npmBinary,
	pathBinary,
	resolveWithStrategies,
} from "./installers.ts";
import { spawnServer } from "./launch.ts";
import manifest from "./lsp-servers.json";

// lsp-servers.json is the single source of truth for server id → npm package →
// binary triples, shared with the eval provisioning scripts. Look bins up here
// instead of restating package/binary names inline.
const MANIFEST_SERVERS: {
	id: string;
	binary: string;
	npmPackage?: string;
}[] = manifest.servers;

function manifestNpmBinary(id: string): LspInstallStrategy {
	const entry = MANIFEST_SERVERS.find((server) => server.id === id);
	if (!entry?.npmPackage) {
		throw new Error(`lsp-servers.json has no npm package for server "${id}"`);
	}
	return npmBinary(entry.npmPackage, entry.binary);
}

export interface ServerContext {
	/** The workspace/project directory the agent is operating in. */
	directory: string;
	flags: LspFlags;
}

export interface ServerHandle {
	process: ChildProcessWithoutNullStreams;
	initialization?: Record<string, unknown>;
}

export interface ServerInfo {
	id: string;
	extensions: string[];
	/** Resolve the project root for `file`, or undefined to skip this server. */
	root: (file: string, ctx: ServerContext) => Promise<string | undefined>;
	/** Start the server, or return undefined when its binary is unavailable. */
	spawn: (
		root: string,
		ctx: ServerContext,
	) => Promise<ServerHandle | undefined>;
}

function requireResolved(
	serverId: string,
	result: BinaryResolutionResult,
): string {
	if (result.ok) return result.path;
	throw new LspServerUnavailableError(serverId, result.reason);
}

async function resolveServerBinary(
	serverId: string,
	flags: LspFlags,
	strategies: readonly LspInstallStrategy[],
): Promise<string> {
	return requireResolved(
		serverId,
		await resolveWithStrategies({ serverId, flags }, strategies),
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Walk up from `file`'s directory to `stop`, returning the first directory that
 * contains any of `markers`. Falls back to `stop` when nothing matches so a
 * lone file still gets a usable root.
 */
function nearestRoot(markers: string[]) {
	return async (file: string, ctx: ServerContext): Promise<string> => {
		let dir = dirname(file);
		const stop = ctx.directory;
		// Bound the climb so a path outside the workspace cannot loop forever.
		for (let i = 0; i < 64; i++) {
			for (const marker of markers) {
				if (await exists(join(dir, marker))) return dir;
			}
			if (dir === stop) break;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return stop;
	};
}

const workspaceRoot = async (_file: string, ctx: ServerContext) =>
	ctx.directory;

const TS_MARKERS = [
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"pnpm-lock.yaml",
	"yarn.lock",
	"tsconfig.json",
];

export const TypeScript: ServerInfo = {
	id: "typescript",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
	root: nearestRoot(TS_MARKERS),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("typescript"),
		]);
		return { process: spawnServer(bin, ["--stdio"], { cwd: root }) };
	},
};

export const Python: ServerInfo = {
	id: "python",
	extensions: [".py", ".pyi"],
	root: nearestRoot([
		"pyproject.toml",
		"setup.py",
		"setup.cfg",
		"requirements.txt",
		"Pipfile",
		".git",
	]),
	async spawn(root, ctx) {
		// Prefer pyright (richest diagnostics) when present and working; fall back
		// to pure-Python servers that need no Node, which is what tends to be
		// installable in locked-down sandboxes.
		const pyright = await resolveWithStrategies(
			{ serverId: this.id, flags: ctx.flags },
			[manifestNpmBinary("pyright")],
		);
		if (pyright.ok) {
			return { process: spawnServer(pyright.path, ["--stdio"], { cwd: root }) };
		}
		const pylsp = await resolveWithStrategies(
			{ serverId: this.id, flags: ctx.flags },
			[pathBinary("pylsp")],
		);
		if (pylsp.ok) {
			return { process: spawnServer(pylsp.path, [], { cwd: root }) };
		}
		const jedi = await resolveWithStrategies(
			{ serverId: this.id, flags: ctx.flags },
			[pathBinary("jedi-language-server")],
		);
		if (jedi.ok) {
			return { process: spawnServer(jedi.path, [], { cwd: root }) };
		}
		throw new LspServerUnavailableError(
			this.id,
			[
				`pyright unavailable: ${pyright.reason}`,
				`pylsp unavailable: ${pylsp.reason}`,
				`jedi-language-server unavailable: ${jedi.reason}`,
			].join("; "),
		);
	},
};

export const Gopls: ServerInfo = {
	id: "gopls",
	extensions: [".go"],
	root: nearestRoot(["go.mod", "go.work", ".git"]),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			pathBinary("gopls"),
			commandInstall({
				id: "go-install:gopls",
				bin: "gopls",
				command: "go",
				args: ["install", "golang.org/x/tools/gopls@v0.16.2"],
				requiredBinary: "go",
			}),
		]);
		return { process: spawnServer(bin, [], { cwd: root }) };
	},
};

export const RustAnalyzer: ServerInfo = {
	id: "rust-analyzer",
	extensions: [".rs"],
	root: nearestRoot(["Cargo.toml", "Cargo.lock", ".git"]),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			pathBinary("rust-analyzer"),
		]);
		return { process: spawnServer(bin, [], { cwd: root }) };
	},
};

export const Clangd: ServerInfo = {
	id: "clangd",
	extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
	root: nearestRoot([
		"compile_commands.json",
		"compile_flags.txt",
		"Makefile",
		"CMakeLists.txt",
		".git",
	]),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			pathBinary("clangd"),
		]);
		return {
			process: spawnServer(bin, ["--background-index"], { cwd: root }),
		};
	},
};

export const BashLs: ServerInfo = {
	id: "bash",
	extensions: [".sh", ".bash"],
	root: workspaceRoot,
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("bash"),
		]);
		return { process: spawnServer(bin, ["start"], { cwd: root }) };
	},
};

export const JsonLs: ServerInfo = {
	id: "json",
	extensions: [".json", ".jsonc"],
	root: workspaceRoot,
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("json"),
		]);
		return { process: spawnServer(bin, ["--stdio"], { cwd: root }) };
	},
};

export const YamlLs: ServerInfo = {
	id: "yaml",
	extensions: [".yaml", ".yml"],
	root: workspaceRoot,
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("yaml"),
		]);
		return { process: spawnServer(bin, ["--stdio"], { cwd: root }) };
	},
};

export const HtmlLs: ServerInfo = {
	id: "html",
	extensions: [".html", ".htm"],
	root: workspaceRoot,
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("html"),
		]);
		return { process: spawnServer(bin, ["--stdio"], { cwd: root }) };
	},
};

export const TexLab: ServerInfo = {
	id: "texlab",
	extensions: [".tex"],
	root: nearestRoot(["texlab.toml", ".latexmkrc", ".git"]),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			pathBinary("texlab"),
		]);
		return { process: spawnServer(bin, [], { cwd: root }) };
	},
};

export const RLanguageServer: ServerInfo = {
	id: "r",
	extensions: [".r", ".R"],
	root: nearestRoot(["DESCRIPTION", "renv.lock", ".Rprofile", ".git"]),
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			pathBinary("R"),
		]);
		return {
			process: spawnServer(bin, ["--slave", "-e", "languageserver::run()"], {
				cwd: root,
			}),
		};
	},
};

export const SqlLs: ServerInfo = {
	id: "sql",
	extensions: [".sql"],
	root: workspaceRoot,
	async spawn(root, ctx) {
		const bin = await resolveServerBinary(this.id, ctx.flags, [
			manifestNpmBinary("sql"),
		]);
		return {
			process: spawnServer(bin, ["up", "--method", "stdio"], { cwd: root }),
		};
	},
};

/** Built-in server registry, keyed by id. */
export const BUILTIN_SERVERS: ServerInfo[] = [
	TypeScript,
	Python,
	Gopls,
	RustAnalyzer,
	Clangd,
	BashLs,
	JsonLs,
	YamlLs,
	HtmlLs,
	TexLab,
	RLanguageServer,
	SqlLs,
];

export function serverExtension(file: string): string {
	return parse(file).ext.toLowerCase();
}
