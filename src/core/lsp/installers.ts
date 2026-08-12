import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BinaryResolutionResult } from "./binaries.ts";
import { resolveBinaryDetailed, resolveNpmBinaryDetailed } from "./binaries.ts";
import type { LspFlags } from "./flags.ts";

export interface LspInstallContext {
	serverId: string;
	flags: LspFlags;
}

export interface LspInstallStrategy {
	readonly id: string;
	resolve(ctx: LspInstallContext): Promise<BinaryResolutionResult>;
}

export function pathBinary(bin: string): LspInstallStrategy {
	return {
		id: `path:${bin}`,
		resolve: (ctx) => resolveBinaryDetailed(bin, ctx.flags),
	};
}

export function npmBinary(pkg: string, bin: string): LspInstallStrategy {
	return {
		id: `npm:${pkg}`,
		resolve: (ctx) => resolveNpmBinaryDetailed(pkg, bin, ctx.flags),
	};
}

export interface CommandInstallOptions {
	readonly id: string;
	readonly bin: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly requiredBinary?: string;
	readonly env?: Record<string, string | undefined>;
}

export function commandInstall(
	options: CommandInstallOptions,
): LspInstallStrategy {
	return {
		id: options.id,
		async resolve(ctx) {
			const existing = await resolveBinaryDetailed(options.bin, ctx.flags);
			if (existing.ok) return existing;

			if (!ctx.flags.allowDownload) {
				return {
					ok: false,
					reason: `${existing.reason}; downloads are disabled`,
				};
			}

			if (options.requiredBinary) {
				const required = await resolveBinaryDetailed(
					options.requiredBinary,
					ctx.flags,
				);
				if (!required.ok) {
					return {
						ok: false,
						reason: `${existing.reason}; installer '${options.id}' requires ${required.reason}`,
					};
				}
			}

			const binDir = join(ctx.flags.cacheDir, "bin");
			await mkdir(binDir, { recursive: true });
			const installed = await runInstaller(options, binDir);
			if (!installed.ok) {
				return {
					ok: false,
					reason: `${existing.reason}; installer '${options.id}' failed: ${installed.reason}`,
				};
			}

			const resolved = await resolveBinaryDetailed(options.bin, ctx.flags);
			if (resolved.ok) return resolved;
			return {
				ok: false,
				reason: `${existing.reason}; installer '${options.id}' completed but binary '${options.bin}' was not found`,
			};
		},
	};
}

export async function resolveWithStrategies(
	ctx: LspInstallContext,
	strategies: readonly LspInstallStrategy[],
): Promise<BinaryResolutionResult> {
	const failures: string[] = [];
	for (const strategy of strategies) {
		const result = await strategy.resolve(ctx);
		if (result.ok) return result;
		failures.push(`${strategy.id}: ${result.reason}`);
	}
	return {
		ok: false,
		reason:
			failures.length > 0
				? failures.join("; ")
				: `no install strategies configured for '${ctx.serverId}'`,
	};
}

function runInstaller(
	options: CommandInstallOptions,
	binDir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	return new Promise((resolvePromise) => {
		const child = spawn(options.command, [...options.args], {
			env: { ...process.env, ...options.env, GOBIN: binDir },
			stdio: "ignore",
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			resolvePromise({ ok: false, reason: "installer timed out" });
		}, 120_000);
		timer.unref?.();
		child.on("error", (error) => {
			clearTimeout(timer);
			resolvePromise({ ok: false, reason: formatError(error) });
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise({ ok: true });
			else resolvePromise({ ok: false, reason: `exit ${code}` });
		});
	});
}

// Unlike utils/errors.ts errorMessage, falls back to String(error) when an
// Error carries a blank message (installer failures often do).
function formatError(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	return String(error);
}
