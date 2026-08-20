import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CliUserError } from "../../config/CliUserError.ts";
import type { Config } from "../../config/Config.ts";
import { qSessionDir } from "../../config/paths.ts";
import { parseRequestedResume } from "../../config/resumePreflight.ts";
import type { AgentController } from "../../core/agent/AgentController.ts";
import type { Message } from "../../core/session/Message.ts";
import type { ResumeIndexEntry } from "../../core/session/ResumeIndex.ts";
import type { AgentClient } from "../../providers/AgentClient.ts";
import { BackboardError } from "../../providers/backboard/errors.ts";
import {
	backboardThreadToMessages,
	threadDisplayTitle,
} from "../../providers/backboard/threads.ts";
import type { BackboardThread } from "../../providers/backboard/types.ts";
import {
	BYOK_SESSION_ID_METADATA_KEY,
	BYOK_THREAD_METADATA_KEY,
	ByokConversationNotFoundError,
} from "../../providers/byok/ByokClient.ts";
import { BackendUnavailableError } from "../../providers/ClientRouter.ts";
import { isByokThreadId, isSessionId } from "../../utils/id.ts";

export interface ResumeTarget {
	displayTitle: string;
	thread: BackboardThread | null;
	messages: Message[];
	localSessionId: string | null;
}

interface ActivateResumeTargetOptions {
	config: Config;
	controller: AgentController;
	onResumeLocalSession: (sessionId: string) => Promise<void>;
	onResumeRemoteSession?: () => Promise<void>;
}

export async function resolveResumeTarget(
	client: AgentClient,
	cwd: string,
	id: string,
	indexedResume: ResumeIndexEntry | null = null,
): Promise<ResumeTarget> {
	const normalized = parseRequestedResume(id);
	const hasLocalSession =
		isSessionId(normalized) &&
		(await isDirectory(qSessionDir(cwd, normalized)));

	if (isSessionId(normalized)) {
		if (
			indexedResume?.threadId &&
			resolve(indexedResume.cwd) === resolve(cwd)
		) {
			try {
				const target = resumeTargetFromHydratedThread(
					await client.getThread(indexedResume.threadId),
				);
				return { ...target, localSessionId: normalized };
			} catch (error) {
				if (
					!hasLocalSession ||
					(!isMissingResumeThread(error) &&
						!(error instanceof BackendUnavailableError))
				) {
					throw error;
				}
				if (error instanceof BackendUnavailableError) {
					return localResumeTarget(normalized);
				}
			}
		}
	}

	if (!isByokThreadId(normalized) && !isSessionId(normalized)) {
		try {
			return resumeTargetFromHydratedThread(await client.getThread(normalized));
		} catch (error) {
			if (!isMissingResumeThread(error)) throw error;
		}
	}

	const threads = await client.listThreads();
	const listed = threads.find(
		(thread) =>
			thread.thread_id === normalized ||
			thread.metadata_?.[BYOK_SESSION_ID_METADATA_KEY] === normalized,
	);
	if (listed) return hydrateResumeTarget(client, listed);

	if (isSessionId(normalized) && hasLocalSession) {
		return localResumeTarget(normalized);
	}

	throw new CliUserError(`Session "${normalized}" was not found.`);
}

export async function hydrateResumeTarget(
	client: AgentClient,
	thread: BackboardThread,
): Promise<ResumeTarget> {
	const hydrated = await client.getThread(thread.thread_id);
	return resumeTargetFromHydratedThread(hydrated);
}

function resumeTargetFromHydratedThread(
	hydrated: BackboardThread,
): ResumeTarget {
	const byok = hydrated.metadata_?.[BYOK_THREAD_METADATA_KEY] === true;
	const localSessionId = byok
		? hydrated.metadata_?.[BYOK_SESSION_ID_METADATA_KEY]
		: null;
	if (
		byok &&
		(typeof localSessionId !== "string" || !isSessionId(localSessionId))
	) {
		throw new CliUserError(
			"Saved BYOK session is missing its local session id.",
		);
	}
	return {
		displayTitle: threadDisplayTitle(hydrated),
		thread: hydrated,
		messages: backboardThreadToMessages(hydrated),
		localSessionId: typeof localSessionId === "string" ? localSessionId : null,
	};
}

export async function activateResumeTarget(
	target: ResumeTarget,
	options: ActivateResumeTargetOptions,
): Promise<void> {
	if (target.localSessionId) {
		await options.onResumeLocalSession(target.localSessionId);
	} else if (target.thread) {
		await options.onResumeRemoteSession?.();
	}

	const thread = target.thread;
	if (!thread) {
		options.controller.newThread();
		return;
	}

	if (thread.metadata_?.[BYOK_THREAD_METADATA_KEY] === true) {
		const provider = thread.metadata_?.model_provider;
		const model = thread.metadata_?.model_name;
		if (
			options.config.flags.model === undefined &&
			typeof provider === "string" &&
			typeof model === "string"
		) {
			options.config.setModel({ provider, model });
			options.controller.setModelContextLimit(null);
		}
	}

	options.controller.hydrateSession({
		threadId: thread.thread_id,
		assistantId: thread.assistant_id,
		messages: target.messages,
	});
}

export function isAlreadyActiveResume(
	id: string,
	activeThreadId: string | null,
	activeSessionId?: string,
): boolean {
	const normalized = id.trim();
	return normalized === activeThreadId || normalized === activeSessionId;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function isMissingResumeThread(error: unknown): boolean {
	return (
		(error instanceof BackboardError && error.status === 404) ||
		error instanceof ByokConversationNotFoundError
	);
}

function localResumeTarget(sessionId: string): ResumeTarget {
	return {
		displayTitle: sessionId,
		thread: null,
		messages: [],
		localSessionId: sessionId,
	};
}
