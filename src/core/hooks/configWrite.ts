import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HookConfigPaths } from "../../config/paths.ts";
import { hookConfigFileSchema, loadHookConfig } from "./config.ts";
import { isToolHookEvent } from "./constants.ts";
import { hookDefinitionHash } from "./hash.ts";
import { normalizeMatcher, validateHookMatcher } from "./matcher.ts";
import type {
	HookConfigFile,
	HookEventName,
	HookGroupConfig,
	LoadedHook,
} from "./types.ts";

export type HookScope = "user" | "project";

export interface AddUserHookInput {
	event: HookEventName;
	matcher?: string;
	command: string;
	name?: string;
}

export interface AddHookInput extends AddUserHookInput {
	scope: HookScope;
}

async function readHookFile(filePath: string): Promise<HookConfigFile> {
	try {
		const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
		const result = hookConfigFileSchema.safeParse(parsed);
		if (!result.success) {
			throw new Error(
				`Cannot edit ${filePath}: existing file is invalid (${result.error.issues
					.map((issue) => issue.message)
					.join("; ")})`,
			);
		}
		return result.data;
	} catch (err) {
		if ((err as { code?: string }).code === "ENOENT") return {};
		throw err;
	}
}

async function writeHookFile(
	filePath: string,
	data: HookConfigFile,
): Promise<void> {
	const result = hookConfigFileSchema.safeParse(data);
	if (!result.success) {
		throw new Error(
			`Refusing to write invalid hooks.json: ${result.error.issues
				.map((issue) => issue.message)
				.join("; ")}`,
		);
	}
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(result.data, null, 2)}\n`);
}

async function appendHookToFile(
	filePath: string,
	input: AddUserHookInput,
): Promise<void> {
	const command = input.command.trim();
	if (!command) throw new Error("Hook command cannot be empty.");
	if (input.matcher !== undefined) {
		const matcherError = validateHookMatcher(input.matcher);
		if (matcherError) throw new Error(matcherError);
	}

	const matcher = isToolHookEvent(input.event)
		? normalizeMatcher(input.matcher)
		: undefined;
	const name = input.name?.trim() ? input.name.trim() : undefined;

	const data = await readHookFile(filePath);
	const hooks = data.hooks ?? {};
	const groups: HookGroupConfig[] = [...(hooks[input.event] ?? [])];

	const sameMatcherIndex = groups.findIndex(
		(group) => normalizeMatcher(group.matcher) === matcher,
	);
	if (sameMatcherIndex >= 0) {
		const group = groups[sameMatcherIndex];
		if (group?.hooks.some((hook) => hook.command === command)) {
			throw new Error("That hook already exists.");
		}
	}

	const newHook = {
		type: "command" as const,
		command,
		...(name ? { name } : {}),
	};
	if (sameMatcherIndex >= 0) {
		const group = groups[sameMatcherIndex];
		if (group) {
			groups[sameMatcherIndex] = { ...group, hooks: [...group.hooks, newHook] };
		}
	} else {
		groups.push({ ...(matcher ? { matcher } : {}), hooks: [newHook] });
	}

	await writeHookFile(filePath, {
		...data,
		hooks: { ...hooks, [input.event]: groups },
	});
}

async function removeHookFromFile(
	filePath: string,
	hook: LoadedHook,
): Promise<void> {
	const data = await readHookFile(filePath);
	const hooks = data.hooks ?? {};
	const groups = hooks[hook.event];
	if (!groups) throw new Error("Hook not found in config.");

	const targetMatcher = normalizeMatcher(hook.matcher);
	let removed = false;

	const nextGroups: HookGroupConfig[] = [];
	for (const group of groups) {
		if (normalizeMatcher(group.matcher) !== targetMatcher) {
			nextGroups.push(group);
			continue;
		}
		// Match on full hook identity, not command alone, so same-command siblings are not confused.
		const remainingHooks = group.hooks.filter((candidate) => {
			const candidateHash = hookDefinitionHash({
				event: hook.event,
				matcher: group.matcher,
				hook: candidate,
			});
			if (!removed && candidateHash === hook.hash) {
				removed = true;
				return false;
			}
			return true;
		});
		if (remainingHooks.length > 0) {
			nextGroups.push({ ...group, hooks: remainingHooks });
		}
	}

	if (!removed) throw new Error("Hook not found in config.");

	const nextHooks = { ...hooks };
	if (nextGroups.length > 0) {
		nextHooks[hook.event] = nextGroups;
	} else {
		delete nextHooks[hook.event];
	}

	await writeHookFile(filePath, { ...data, hooks: nextHooks });
}

async function setUserTrust(
	userPath: string,
	hash: string,
	trusted: boolean,
): Promise<void> {
	const data = await readHookFile(userPath);
	const current = data.trustedProjectHookHashes ?? [];
	const has = current.includes(hash);
	if (trusted === has) return;
	const next = trusted
		? [...current, hash]
		: current.filter((value) => value !== hash);
	await writeHookFile(userPath, { ...data, trustedProjectHookHashes: next });
}

function findLoadedHook(
	paths: HookConfigPaths,
	scope: HookScope,
	input: AddUserHookInput,
): LoadedHook | undefined {
	const matcher = isToolHookEvent(input.event)
		? normalizeMatcher(input.matcher)
		: undefined;
	const command = input.command.trim();
	return loadHookConfig(paths).hooks.find(
		(hook) =>
			hook.source.kind === scope &&
			hook.event === input.event &&
			normalizeMatcher(hook.matcher) === matcher &&
			hook.hook.command === command,
	);
}

export async function addUserHook(
	paths: HookConfigPaths,
	input: AddUserHookInput,
): Promise<void> {
	await appendHookToFile(paths.user, input);
}

export async function addProjectHook(
	paths: HookConfigPaths,
	input: AddUserHookInput,
): Promise<void> {
	await appendHookToFile(paths.project, input);
	const added = findLoadedHook(paths, "project", input);
	if (added) await setUserTrust(paths.user, added.hash, true);
}

export async function addHook(
	paths: HookConfigPaths,
	input: AddHookInput,
): Promise<void> {
	if (input.scope === "project") {
		await addProjectHook(paths, input);
	} else {
		await addUserHook(paths, input);
	}
}

export async function removeUserHook(
	paths: HookConfigPaths,
	hook: LoadedHook,
): Promise<void> {
	await removeHookFromFile(paths.user, hook);
}

export async function removeProjectHook(
	paths: HookConfigPaths,
	hook: LoadedHook,
): Promise<void> {
	await removeHookFromFile(paths.project, hook);
	await setUserTrust(paths.user, hook.hash, false);
}

export async function removeHook(
	paths: HookConfigPaths,
	hook: LoadedHook,
): Promise<void> {
	if (hook.source.kind === "project") {
		await removeProjectHook(paths, hook);
	} else {
		await removeUserHook(paths, hook);
	}
}
