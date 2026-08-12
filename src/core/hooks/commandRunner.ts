import { spawn } from "node:child_process";
import os from "node:os";
import { errorMessage } from "../../utils/errors.ts";
import { killProcessTree, treeSpawnOptions } from "../../utils/processTree.ts";
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	HOOK_ENV_PREFIX,
	MAX_HOOK_OUTPUT,
	SAFE_HOOK_ENV_KEYS,
} from "./constants.ts";
import type { HookInput, HookOutput, LoadedHook } from "./types.ts";

const KILL_GRACE_MS = 2000;

export type CommandHookRunResult =
	| { status: "success"; output: HookOutput; stderr: string }
	| { status: "blocked"; reason: string; stderr: string }
	| { status: "warning"; warning: string; stderr: string };

export interface CommandHookRunnerOptions {
	cwd: string;
	projectDir: string;
	sessionId: string;
	signal: AbortSignal;
}

export async function runCommandHook(
	loadedHook: LoadedHook,
	input: HookInput,
	options: CommandHookRunnerOptions,
): Promise<CommandHookRunResult> {
	// Already out of budget (e.g. an earlier terminal hook spent it): don't spawn.
	if (options.signal.aborted) {
		return {
			status: "warning",
			warning: `${formatHookName(loadedHook)} was aborted`,
			stderr: "",
		};
	}
	const timeoutMs = loadedHook.hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
	const env = buildHookEnv(options);
	const child = spawn(loadedHook.hook.command, {
		cwd: options.cwd,
		env,
		shell: true,
		stdio: ["pipe", "pipe", "pipe"],
		// Own process group so we can kill grandchildren too (a hook that
		// backgrounds a child must not keep the pipe open and hang the turn).
		...treeSpawnOptions(),
	});

	let stdout = "";
	let stderr = "";
	let settled = false;
	let timedOut = false;
	let outputLimitHit = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	const escalateKill = (): void => {
		killProcessTree(child, "SIGTERM");
		killTimer = setTimeout(
			() => killProcessTree(child, "SIGKILL"),
			KILL_GRACE_MS,
		);
	};

	const timer = setTimeout(() => {
		timedOut = true;
		escalateKill();
	}, timeoutMs);

	const abort = (): void => {
		escalateKill();
	};
	options.signal.addEventListener("abort", abort, { once: true });

	// Cap the buffer and kill a hook that keeps streaming.
	const append = (current: string, chunk: unknown): string => {
		const next = current + String(chunk);
		if (next.length <= MAX_HOOK_OUTPUT) return next;
		if (!outputLimitHit) {
			outputLimitHit = true;
			escalateKill();
		}
		return next.slice(0, MAX_HOOK_OUTPUT);
	};

	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk) => {
		stdout = append(stdout, chunk);
	});
	child.stderr?.on("data", (chunk) => {
		stderr = append(stderr, chunk);
	});

	// Swallow EPIPE when a hook ignores stdin and closes the pipe early.
	child.stdin?.on("error", () => {});
	child.stdin?.end(`${JSON.stringify(input)}\n`);

	return await new Promise<CommandHookRunResult>((resolve) => {
		const finish = (result: CommandHookRunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			options.signal.removeEventListener("abort", abort);
			resolve(result);
		};

		child.on("error", (err) => {
			finish({
				status: "warning",
				warning: `${formatHookName(loadedHook)} failed to start: ${err.message}`,
				stderr,
			});
		});

		child.on("close", (code) => {
			if (timedOut) {
				finish({
					status: "warning",
					warning: `${formatHookName(loadedHook)} timed out after ${timeoutMs}ms`,
					stderr,
				});
				return;
			}
			if (options.signal.aborted) {
				finish({
					status: "warning",
					warning: `${formatHookName(loadedHook)} was aborted`,
					stderr,
				});
				return;
			}
			if (outputLimitHit) {
				finish({
					status: "warning",
					warning: `${formatHookName(loadedHook)} produced more than ${MAX_HOOK_OUTPUT} characters and was terminated`,
					stderr,
				});
				return;
			}
			if (code === 2) {
				finish({
					status: "blocked",
					reason: stderr.trim() || "Blocked by hook",
					stderr,
				});
				return;
			}
			if (code !== 0) {
				finish({
					status: "warning",
					warning: `${formatHookName(loadedHook)} exited with code ${code ?? "unknown"}`,
					stderr,
				});
				return;
			}
			const parsed = parseHookOutput(stdout, loadedHook);
			finish({ ...parsed, stderr });
		});
	});
}

function buildHookEnv(options: CommandHookRunnerOptions): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of SAFE_HOOK_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("LC_") && value !== undefined) env[key] = value;
	}
	env[`${HOOK_ENV_PREFIX}PROJECT_DIR`] = options.projectDir;
	env[`${HOOK_ENV_PREFIX}SESSION_ID`] = options.sessionId;
	env[`${HOOK_ENV_PREFIX}CWD`] = options.cwd;
	env.PWD = options.cwd;
	env.INIT_CWD = options.cwd;
	env.HOME = env.HOME ?? os.homedir();
	return env;
}

function parseHookOutput(
	stdout: string,
	loadedHook: LoadedHook,
):
	| { status: "success"; output: HookOutput }
	| { status: "warning"; warning: string } {
	const trimmed = stdout.trim();
	if (!trimmed) return { status: "success", output: {} };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isHookOutput(parsed)) {
			return {
				status: "warning",
				warning: `${formatHookName(loadedHook)} printed invalid hook JSON`,
			};
		}
		return { status: "success", output: parsed };
	} catch (err) {
		return {
			status: "warning",
			warning: `${formatHookName(loadedHook)} printed non-JSON stdout: ${errorMessage(
				err,
			)}`,
		};
	}
}

function isHookOutput(value: unknown): value is HookOutput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	// Tolerate unknown/forward-compat keys so a valid deny is not dropped.
	if (
		record.systemMessage !== undefined &&
		typeof record.systemMessage !== "string"
	) {
		return false;
	}
	if (
		record.decision !== undefined &&
		record.decision !== "allow" &&
		record.decision !== "deny" &&
		record.decision !== "block"
	) {
		return false;
	}
	if (record.reason !== undefined && typeof record.reason !== "string") {
		return false;
	}
	if (record.continue !== undefined && typeof record.continue !== "boolean") {
		return false;
	}
	if (
		record.stopReason !== undefined &&
		typeof record.stopReason !== "string"
	) {
		return false;
	}
	return !(
		record.hookSpecificOutput !== undefined &&
		(!record.hookSpecificOutput ||
			typeof record.hookSpecificOutput !== "object" ||
			Array.isArray(record.hookSpecificOutput))
	);
}

export function formatHookName(hook: LoadedHook): string {
	return hook.hook.name
		? `Hook '${hook.hook.name}'`
		: `Hook '${hook.hook.command}'`;
}
