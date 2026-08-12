import { readFileSync } from "node:fs";
import { z } from "zod";
import { errorMessage } from "../../utils/errors.ts";
import { HOOK_EVENT_NAMES, isToolHookEvent } from "./constants.ts";
import { hookDefinitionHash } from "./hash.ts";
import { validateHookMatcher } from "./matcher.ts";
import type {
	CommandHookConfig,
	HookConfigFile,
	HookConfigPaths,
	HookEventName,
	HookGroupConfig,
	HookSource,
	LoadedHook,
	LoadedHookConfig,
} from "./types.ts";

const commandHookSchema = z.object({
	type: z.literal("command"),
	command: z.string().trim().min(1),
	name: z.string().trim().min(1).optional(),
	timeoutMs: z.number().int().positive().optional(),
});

const hookGroupSchema = z.object({
	matcher: z.string().optional(),
	hooks: z.array(commandHookSchema).min(1),
});

const hooksByEventSchema = z
	.object({
		SessionStart: z.array(hookGroupSchema).optional(),
		UserPromptSubmit: z.array(hookGroupSchema).optional(),
		PreToolUse: z.array(hookGroupSchema).optional(),
		PostToolUse: z.array(hookGroupSchema).optional(),
		Stop: z.array(hookGroupSchema).optional(),
		SessionEnd: z.array(hookGroupSchema).optional(),
	})
	// Ignore unknown/forward-compat keys instead of rejecting the whole file.
	.passthrough();

export const hookConfigFileSchema = z
	.object({
		trustedProjectHookHashes: z.array(z.string().trim().min(1)).optional(),
		hooks: hooksByEventSchema.optional(),
	})
	.passthrough();

export function loadHookConfig(paths: HookConfigPaths): LoadedHookConfig {
	const user = readHookConfig(paths.user, { kind: "user", path: paths.user });
	const trustedProjectHookHashes = user.config.trustedProjectHookHashes ?? [];
	const project = readHookConfig(paths.project, {
		kind: "project",
		path: paths.project,
	});
	const hooks = [
		...flattenHooks(user.config, user.source, trustedProjectHookHashes),
		...flattenHooks(project.config, project.source, trustedProjectHookHashes),
	];

	const warnings = [...user.warnings, ...project.warnings];
	for (const hook of hooks) {
		if (hook.source.kind === "project" && !hook.trusted) {
			warnings.push(
				`Skipped untrusted project hook ${formatHookId(hook)} for ${hook.event} (${hook.hash}). Add this hash to trustedProjectHookHashes in ${paths.user} to trust it.`,
			);
		}
		// An invalid matcher regex never matches at runtime; warn instead of
		// silently disabling the hook.
		if (isToolHookEvent(hook.event) && hook.matcher) {
			const matcherError = validateHookMatcher(hook.matcher);
			if (matcherError) {
				warnings.push(
					`Hook ${formatHookId(hook)} for ${hook.event} has an invalid matcher and will never run: ${matcherError}`,
				);
			}
		}
	}

	return { hooks, trustedProjectHookHashes, warnings };
}

function readHookConfig(
	path: string,
	source: HookSource,
): { config: HookConfigFile; source: HookSource; warnings: string[] } {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		const result = hookConfigFileSchema.safeParse(parsed);
		if (!result.success) {
			return {
				config: {},
				source,
				warnings: [
					`Skipped hooks in ${path}: ${result.error.issues
						.map((issue) => issue.message)
						.join("; ")}`,
				],
			};
		}
		return { config: result.data, source, warnings: [] };
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") {
			return { config: {}, source, warnings: [] };
		}
		return {
			config: {},
			source,
			warnings: [`Skipped hooks in ${path}: ${errorMessage(err)}`],
		};
	}
}

function flattenHooks(
	config: HookConfigFile,
	source: HookSource,
	trustedProjectHookHashes: readonly string[],
): LoadedHook[] {
	const hooks: LoadedHook[] = [];
	for (const event of HOOK_EVENT_NAMES) {
		const groups = config.hooks?.[event] ?? [];
		for (const group of groups) {
			hooks.push(
				...flattenGroup(event, group, source, trustedProjectHookHashes),
			);
		}
	}
	return hooks;
}

function flattenGroup(
	event: HookEventName,
	group: HookGroupConfig,
	source: HookSource,
	trustedProjectHookHashes: readonly string[],
): LoadedHook[] {
	return group.hooks.map((hook) => {
		const hash = hookDefinitionHash({ event, matcher: group.matcher, hook });
		return {
			event,
			matcher: group.matcher,
			hook: normalizeHook(hook),
			source,
			hash,
			trusted:
				source.kind === "user" || trustedProjectHookHashes.includes(hash),
		};
	});
}

function normalizeHook(hook: CommandHookConfig): CommandHookConfig {
	return {
		type: "command",
		command: hook.command,
		...(hook.name ? { name: hook.name } : {}),
		...(hook.timeoutMs !== undefined ? { timeoutMs: hook.timeoutMs } : {}),
	};
}

function formatHookId(hook: LoadedHook): string {
	return hook.hook.name ? `'${hook.hook.name}'` : `'${hook.hook.command}'`;
}
