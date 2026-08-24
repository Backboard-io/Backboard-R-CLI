import { readFile } from "node:fs/promises";
import { type ModelRef, parseModel } from "../../config/defaults.ts";
import { qSessionDir } from "../../config/paths.ts";
import { ByokConversationStore } from "../../providers/byok/ByokConversationStore.ts";
import { isByokThreadId, isSessionId } from "../../utils/id.ts";
import { sessionPathsForRoot } from "./SessionStore.ts";

export interface LocalResumeBootstrap {
	kind: "byok" | "session";
	sessionId: string;
	threadId?: string;
	model?: ModelRef;
}

/**
 * Resolves local IDs before authentication. This prevents a missing/wrong
 * workspace from being misreported as a need for Backboard SSO.
 */
export async function resolveLocalResumeBootstrap(
	cwd: string,
	id: string | undefined,
	sessionIdHint?: string,
): Promise<LocalResumeBootstrap | null> {
	const normalized = id?.trim();
	if (!normalized || !isLocalResumeId(normalized)) return null;
	const conversationStore = new ByokConversationStore(cwd);
	const likelySessionId = isSessionId(normalized)
		? normalized
		: sessionIdHint && isSessionId(sessionIdHint)
			? sessionIdHint
			: undefined;
	const directConversation = likelySessionId
		? await conversationStore.getAtSessionRoot(
				qSessionDir(cwd, likelySessionId),
				isByokThreadId(normalized) ? normalized : undefined,
			)
		: null;
	if (directConversation) return conversationBootstrap(directConversation);
	if (isSessionId(normalized)) {
		const meta = await readSessionMeta(cwd, normalized);
		if (!meta) return null;
		return {
			kind: "session",
			sessionId: normalized,
			...(meta.model ? { model: meta.model } : {}),
		};
	}
	const conversation = (await conversationStore.list()).find(
		(candidate) =>
			candidate.threadId === normalized || candidate.sessionId === normalized,
	);
	if (conversation) {
		return conversationBootstrap(conversation);
	}
	return null;
}

export function isLocalResumeId(id: string): boolean {
	return isByokThreadId(id) || isSessionId(id);
}

export function isRemoteResumeId(id: string | undefined): boolean {
	const normalized = id?.trim();
	return Boolean(normalized && !isLocalResumeId(normalized));
}

async function readSessionMeta(
	cwd: string,
	sessionId: string,
): Promise<{ model?: ModelRef } | null> {
	try {
		const value = JSON.parse(
			await readFile(
				sessionPathsForRoot(qSessionDir(cwd, sessionId)).meta,
				"utf8",
			),
		) as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			!("sessionId" in value) ||
			value.sessionId !== sessionId
		) {
			return null;
		}
		if ("model" in value && typeof value.model === "string") {
			try {
				return { model: parseModel(value.model) };
			} catch {
				return {};
			}
		}
		return {};
	} catch {
		return null;
	}
}

function conversationBootstrap(conversation: {
	threadId: string;
	sessionId: string;
	provider: ModelRef["provider"];
	model: string;
}): LocalResumeBootstrap {
	return {
		kind: "byok",
		threadId: conversation.threadId,
		sessionId: conversation.sessionId,
		model: {
			provider: conversation.provider,
			model: conversation.model,
		},
	};
}
