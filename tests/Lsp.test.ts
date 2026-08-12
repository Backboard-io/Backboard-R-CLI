import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { EventBus } from "../src/core/bus/EventBus.ts";
import { resolveNpmBinaryDetailed } from "../src/core/lsp/binaries.ts";
import { reportDiagnostics } from "../src/core/lsp/diagnostics.ts";
import { LspServerUnavailableError } from "../src/core/lsp/errors.ts";
import { resolveLspFlags } from "../src/core/lsp/flags.ts";
import {
	commandInstall,
	pathBinary,
	resolveWithStrategies,
} from "../src/core/lsp/installers.ts";
import { LspService } from "../src/core/lsp/LspService.ts";
import { languageIdForPath } from "../src/core/lsp/language.ts";
import { spawnServer } from "../src/core/lsp/launch.ts";
import type { ServerInfo } from "../src/core/lsp/servers.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { EditTool } from "../src/tools/EditTool.tsx";

const FIXTURE = join(import.meta.dir, "fixtures", "fakeLsp.ts");

function fakeServer(): ServerInfo {
	return {
		id: "fake",
		extensions: [".fake"],
		root: async (_file, ctx) => ctx.directory,
		spawn: async (root) => ({
			process: spawnServer("bun", ["run", FIXTURE], { cwd: root }),
		}),
	};
}

function unavailableServer(message = "test server missing"): ServerInfo {
	return {
		id: "missing",
		extensions: [".missing"],
		root: async (_file, ctx) => ctx.directory,
		spawn: async () => {
			throw new LspServerUnavailableError("missing", message);
		},
	};
}

describe("lsp diagnostics report", () => {
	it("renders only errors, capped and formatted", () => {
		const block = reportDiagnostics("src/a.ts", [
			{
				range: {
					start: { line: 4, character: 2 },
					end: { line: 4, character: 8 },
				},
				severity: 1,
				code: "TS2304",
				message: "Cannot find name 'bar'.",
			},
			{
				range: {
					start: { line: 9, character: 0 },
					end: { line: 9, character: 1 },
				},
				severity: 2,
				message: "unused",
			},
		]);
		expect(block).toContain('<diagnostics file="src/a.ts">');
		expect(block).toContain("ERROR [5:3] TS2304 Cannot find name 'bar'.");
		expect(block).not.toContain("unused");
	});

	it("returns empty string when there are no errors", () => {
		expect(reportDiagnostics("x.ts", [])).toBe("");
	});

	it("suppresses noisy import-resolution codes but keeps real errors", () => {
		const block = reportDiagnostics("m.py", [
			{
				range: {
					start: { line: 0, character: 0 },
					end: { line: 0, character: 12 },
				},
				severity: 1,
				code: "reportMissingImports",
				message: 'Import "sympy" could not be resolved',
			},
			{
				range: {
					start: { line: 3, character: 4 },
					end: { line: 3, character: 7 },
				},
				severity: 1,
				code: "reportUndefinedVariable",
				message: '"foo" is not defined',
			},
		]);
		expect(block).not.toContain("sympy");
		expect(block).not.toContain("reportMissingImports");
		expect(block).toContain("reportUndefinedVariable");
		expect(block).toContain('"foo" is not defined');
	});

	it("returns empty string when only suppressed codes are present", () => {
		expect(
			reportDiagnostics("m.py", [
				{
					range: {
						start: { line: 0, character: 0 },
						end: { line: 0, character: 5 },
					},
					severity: 1,
					code: "reportMissingModuleSource",
					message: 'Import "torch" could not be resolved from source',
				},
			]),
		).toBe("");
	});
});

describe("language id mapping", () => {
	it("maps known extensions and falls back to plaintext", () => {
		expect(languageIdForPath("a.ts")).toBe("typescript");
		expect(languageIdForPath("a.py")).toBe("python");
		expect(languageIdForPath("a.html")).toBe("html");
		expect(languageIdForPath("a.tex")).toBe("latex");
		expect(languageIdForPath("a.R")).toBe("r");
		expect(languageIdForPath("a.sql")).toBe("sql");
		expect(languageIdForPath("a.unknownext")).toBe("plaintext");
		expect(languageIdForPath("Makefile")).toBe("plaintext");
	});
});

describe("lsp flags", () => {
	it("defaults off and disables downloads under benchmark mode", () => {
		const flags = resolveLspFlags({
			BACKBOARD_BENCHMARK: "1",
			HOME: "/home/x",
		});
		expect(flags.enabled).toBe(false);
		expect(flags.allowDownload).toBe(false);
		expect(flags.cacheDir).toBe("/home/x/.backboard/lsp");
	});

	it("honors explicit overrides", () => {
		const flags = resolveLspFlags({
			BACKBOARD_LSP: "1",
			BACKBOARD_LSP_DOWNLOAD: "1",
			BACKBOARD_BENCHMARK: "1",
			LSP_CACHE_DIR: "/cache",
		});
		expect(flags.enabled).toBe(true);
		expect(flags.allowDownload).toBe(true);
		expect(flags.cacheDir).toBe("/cache");
	});

	it("ignores relative cache dir overrides", () => {
		const flags = resolveLspFlags({
			HOME: "/home/x",
			BACKBOARD_LSP_DIR: ".backboard/lsp",
		});
		expect(flags.cacheDir).toBe("/home/x/.backboard/lsp");
	});

	it("never falls back to a relative cache dir when HOME is unset", () => {
		const flags = resolveLspFlags({});
		expect(isAbsolute(flags.cacheDir)).toBe(true);
	});
});

describe("lsp binary resolution", () => {
	it("reports when npm downloads are disabled", async () => {
		const result = await resolveNpmBinaryDetailed(
			"definitely-not-installed-lsp-package",
			"definitely-not-installed-lsp-binary",
			{
				enabled: true,
				allowDownload: false,
				cacheDir: "/tmp/q-cli-missing-lsp-cache",
			},
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("downloads are disabled");
			expect(result.reason).toContain("definitely-not-installed-lsp-binary");
		}
	});

	it("resolves install strategies in order from the cache", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-cache-"));
		const binDir = join(dir, "bin");
		const bin = join(binDir, "cached-lsp");
		await mkdir(binDir, { recursive: true });
		await writeFile(bin, "#!/bin/sh\nexit 0\n", "utf8");
		await chmod(bin, 0o755);

		const result = await resolveWithStrategies(
			{
				serverId: "cached",
				flags: { enabled: true, allowDownload: false, cacheDir: dir },
			},
			[pathBinary("missing-lsp"), pathBinary("cached-lsp")],
		);

		expect(result).toEqual({ ok: true, path: bin });
	});

	it("reports disabled command installers without running them", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-installer-"));
		const result = await resolveWithStrategies(
			{
				serverId: "native",
				flags: { enabled: true, allowDownload: false, cacheDir: dir },
			},
			[
				commandInstall({
					id: "native-install",
					bin: "native-lsp",
					command: "definitely-not-run",
					args: ["install"],
				}),
			],
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain("native-install");
			expect(result.reason).toContain("downloads are disabled");
			expect(result.reason).toContain("native-lsp");
		}
	});
});

describe("lsp service end-to-end with a fake server", () => {
	it("collects diagnostics for a touched file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-"));
		const file = join(dir, "sample.fake");
		await writeFile(file, "broken code\n", "utf8");

		const service = new LspService({
			directory: dir,
			flags: { enabled: true, allowDownload: false, cacheDir: dir },
			servers: [fakeServer()],
		});

		await service.touchFile(file, { waitForDiagnostics: true });
		const diagnostics = service.diagnosticsForFile(file);
		await service.shutdown();

		expect(diagnostics.length).toBe(1);
		expect(diagnostics[0]?.message).toBe("fake diagnostic");
		expect(reportDiagnostics("sample.fake", diagnostics)).toContain(
			"fake diagnostic",
		);
	});

	it("is a no-op when disabled", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-"));
		const service = new LspService({
			directory: dir,
			flags: { enabled: false, allowDownload: false, cacheDir: dir },
			servers: [fakeServer()],
		});
		await service.touchFile(join(dir, "x.fake"), {
			waitForDiagnostics: true,
		});
		expect(service.status().length).toBe(0);
		await service.shutdown();
	});

	it("records and warns once when a matching server is unavailable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-missing-"));
		const file = join(dir, "sample.missing");
		await writeFile(file, "broken code\n", "utf8");
		const warnings: string[] = [];
		const service = new LspService({
			directory: dir,
			flags: { enabled: true, allowDownload: false, cacheDir: dir },
			servers: [unavailableServer()],
			onWarning: (message) => warnings.push(message),
		});

		await service.touchFile(file, { waitForDiagnostics: true });
		await service.touchFile(file, { waitForDiagnostics: true });
		const status = service.status();
		await service.shutdown();

		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("LSP server 'missing' unavailable");
		expect(warnings[0]).toContain("test server missing");
		expect(status).toEqual([
			{
				id: "missing",
				root: dir,
				status: "error",
				message: "test server missing",
			},
		]);
	});
});

describe("edit tool diagnostics feedback", () => {
	it("appends an LSP error block to the model output after editing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "q-cli-lsp-edit-"));
		await writeFile(join(dir, "sample.fake"), "alpha\n", "utf8");
		const service = new LspService({
			directory: dir,
			flags: { enabled: true, allowDownload: false, cacheDir: dir },
			servers: [fakeServer()],
		});
		const ctx: ToolContext = {
			sessionId: "sess_test",
			cwd: dir,
			bus: new EventBus(),
			signal: new AbortController().signal,
			askUser: async () => "noop",
			agentDepth: 0,
			lsp: service,
		};

		const result = await new EditTool().execute(
			{
				file_path: "sample.fake",
				edits: [{ old_str: "alpha", new_str: "beta" }],
			},
			ctx,
		);
		await service.shutdown();

		expect(result.forLLM).toContain("LSP errors detected in this file");
		expect(result.forLLM).toContain("fake diagnostic");
	});
});
