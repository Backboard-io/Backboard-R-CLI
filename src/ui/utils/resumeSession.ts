import { stat } from "node:fs/promises";
import type { Config } from "../../config/Config.ts";
import { qSessionDir } from "../../config/paths.ts";
import type { AgentController } from "../../core/agent/AgentController.ts";
import type { Message } from "../../core/session/Message.ts";
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
} from "../../providers/byok/ByokClient.ts";
import { errorMessage } from "../../utils/errors.ts";
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
	onWarning?: (message: string) => void;
}

export async function resolveResumeTarget(
	client: AgentClient,
	cwd: string,
	id: string,
): Promise<ResumeTarget> {
	const normalized = id.trim();
	if (!normalized) throw new Error("A session ID is required.");

	if (!isByokThreadId(normalized) && !isSessionId(normalized)) {
		try {
			return resumeTargetFromHydratedThread(await client.getThread(normalized));
		} catch (error) {
			if (!(error instanceof BackboardError) || error.status !== 404) {
				throw error;
			}
		}
	}

	const threads = await client.listThreads();
	const listed = threads.find(
		(thread) =>
			thread.thread_id === normalized ||
			thread.metadata_?.[BYOK_SESSION_ID_METADATA_KEY] === normalized,
	);
	if (listed) return hydrateResumeTarget(client, listed);

	if (
		isSessionId(normalized) &&
		(await isDirectory(qSessionDir(cwd, normalized)))
	) {
		return {
			displayTitle: normalized,
			thread: null,
			messages: [],
			localSessionId: normalized,
		};
	}

	throw new Error(`Session "${normalized}" was not found.`);
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
		throw new Error("Saved BYOK session is missing its local session id.");
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
		if (typeof provider === "string" && typeof model === "string") {
			options.config.setModel({ provider, model });
			options.controller.setModelContextLimit(null);
			await options.config.saveRuntimeSelection().catch((error) => {
				options.onWarning?.(
					`Session resumed, but saving its model failed: ${errorMessage(error)}`,
				);
			});
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
): boolean {
	return activeThreadId !== null && id.trim() === activeThreadId;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}
