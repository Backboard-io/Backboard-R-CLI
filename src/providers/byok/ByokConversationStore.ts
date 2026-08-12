import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { qSessionDir } from "../../config/paths.ts";
import {
	type ByokProviderId,
	isByokProviderId,
} from "../../core/keys/ProviderKeyTypes.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { ensureDir, renameOver } from "../../utils/fs.ts";
import {
	BYOK_CONVERSATION_FILE,
	BYOK_CONVERSATION_LOCK_FILE,
	BYOK_CONVERSATION_LOCK_RETRY_MS,
	BYOK_CONVERSATION_LOCK_TIMEOUT_MS,
	BYOK_CONVERSATION_SCHEMA_VERSION,
} from "./ByokConversationStore.constants.ts";
import type { ByokMessage } from "./ByokTypes.ts";

export interface StoredByokConversation {
	version: typeof BYOK_CONVERSATION_SCHEMA_VERSION;
	revision: number;
	threadId: string;
	sessionId: string;
	sessionRoot: string;
	provider: ByokProviderId;
	model: string;
	systemPrompt: string;
	createdAt: string;
	updatedAt: string;
	messages: ByokMessage[];
}

export class ByokConversationStore {
	constructor(private readonly baseDir: string) {}

	async save(
		conversation: StoredByokConversation,
		expectedRevision: number,
		replacesThreadId?: string,
	): Promise<number> {
		const sessionRoot = qSessionDir(this.baseDir, conversation.sessionId);
		const path = this.pathFor(sessionRoot);
		await ensureDir(sessionRoot);
		const lease = await acquireFileLease(
			join(sessionRoot, BYOK_CONVERSATION_LOCK_FILE),
			{
				label: `conversation ${conversation.threadId}`,
				timeoutMs: BYOK_CONVERSATION_LOCK_TIMEOUT_MS,
				retryMs: BYOK_CONVERSATION_LOCK_RETRY_MS,
				invalidOwnerStaleMs: BYOK_CONVERSATION_LOCK_TIMEOUT_MS,
			},
		);
		try {
			const existing = await this.readPathForSave(path);
			if (
				existing &&
				existing.threadId !== conversation.threadId &&
				existing.threadId !== replacesThreadId
			) {
				throw new Error(
					`Session ${conversation.sessionId} is already owned by conversation ${existing.threadId}. Start a new session before creating another durable conversation.`,
				);
			}
			const actualRevision = existing?.revision ?? 0;
			if (actualRevision !== expectedRevision) {
				throw new Error(
					`Conversation ${conversation.threadId} changed in another CLI process. Resume it again before sending more messages.`,
				);
			}
			const revision = actualRevision + 1;
			const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
			try {
				await writeFile(
					temporary,
					`${JSON.stringify(
						{
							...conversation,
							version: BYOK_CONVERSATION_SCHEMA_VERSION,
							revision,
							sessionRoot,
						},
						null,
						2,
					)}\n`,
					"utf8",
				);
				await renameOver(temporary, path);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			return revision;
		} finally {
			await lease.release();
		}
	}

	async get(
		threadId: string,
		options: { repairInterruptedToolTurn?: boolean } = {},
	): Promise<StoredByokConversation | null> {
		const conversations = await this.listConversations(
			options.repairInterruptedToolTurn ?? true,
		);
		return (
			conversations.find(
				(conversation) => conversation.threadId === threadId,
			) ?? null
		);
	}

	async getAtSessionRoot(
		sessionRoot: string,
		threadId: string,
		options: { repairInterruptedToolTurn?: boolean } = {},
	): Promise<StoredByokConversation | null> {
		const conversation = await this.readPath(
			this.pathFor(sessionRoot),
			options.repairInterruptedToolTurn ?? true,
		);
		if (
			!conversation ||
			conversation.threadId !== threadId ||
			basename(sessionRoot) !== conversation.sessionId
		) {
			return null;
		}
		return { ...conversation, sessionRoot };
	}

	async list(): Promise<StoredByokConversation[]> {
		return await this.listConversations(true);
	}

	private async listConversations(
		repairInterrupted: boolean,
	): Promise<StoredByokConversation[]> {
		const root = dirname(qSessionDir(this.baseDir, "_"));
		let entries: string[];
		try {
			entries = await readdir(root);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return [];
			throw error;
		}

		const conversations: StoredByokConversation[] = [];
		for (const entry of entries) {
			try {
				const sessionRoot = join(root, entry);
				const conversation = await this.readPath(
					this.pathFor(sessionRoot),
					repairInterrupted,
				);
				if (conversation && basename(sessionRoot) === conversation.sessionId) {
					conversations.push({ ...conversation, sessionRoot });
				}
			} catch {
				// One unreadable/corrupt session must not hide the rest.
			}
		}
		return conversations.sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	private pathFor(sessionRoot: string): string {
		return join(sessionRoot, BYOK_CONVERSATION_FILE);
	}

	private async readPath(
		path: string,
		repairInterrupted = true,
	): Promise<StoredByokConversation | null> {
		try {
			return parseConversation(
				JSON.parse(await readFile(path, "utf8")) as unknown,
				repairInterrupted,
			);
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			throw error;
		}
	}

	private async readPathForSave(
		path: string,
	): Promise<StoredByokConversation | null> {
		try {
			const parsed = parseConversation(
				JSON.parse(await readFile(path, "utf8")) as unknown,
				false,
			);
			if (!parsed) {
				throw new Error(
					`Saved conversation ${path} is malformed or uses an unsupported schema. Refusing to overwrite it.`,
				);
			}
			return parsed;
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") return null;
			if (error instanceof SyntaxError) {
				throw new Error(
					`Saved conversation ${path} is malformed. Refusing to overwrite it.`,
					{ cause: error },
				);
			}
			throw error;
		}
	}
}

function parseConversation(
	value: unknown,
	repairInterrupted = true,
): StoredByokConversation | null {
	if (!isObject(value) || value.version !== BYOK_CONVERSATION_SCHEMA_VERSION) {
		return null;
	}
	if (
		typeof value.threadId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionRoot !== "string" ||
		!isProvider(value.provider) ||
		typeof value.model !== "string" ||
		typeof value.systemPrompt !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string" ||
		!Array.isArray(value.messages)
	) {
		return null;
	}
	const messages = value.messages.filter(isByokMessage);
	if (messages.length !== value.messages.length) return null;
	return {
		version: BYOK_CONVERSATION_SCHEMA_VERSION,
		revision:
			typeof value.revision === "number" &&
			Number.isInteger(value.revision) &&
			value.revision >= 0
				? value.revision
				: 0,
		threadId: value.threadId,
		sessionId: value.sessionId,
		sessionRoot: value.sessionRoot,
		provider: value.provider,
		model: value.model,
		systemPrompt: value.systemPrompt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		messages: repairInterrupted
			? repairInterruptedToolTurn(messages)
			: messages,
	};
}

export function repairInterruptedToolTurn(
	messages: ByokMessage[],
): ByokMessage[] {
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant" || message.toolCalls.length === 0)
			continue;
		const next = messages[index + 1];
		if (next?.role !== "tool") return messages.slice(0, index);
		const results = new Set(next.results.map((result) => result.id));
		if (message.toolCalls.some((call) => !results.has(call.id))) {
			return messages.slice(0, index);
		}
	}
	return messages;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is ByokProviderId {
	return typeof value === "string" && isByokProviderId(value);
}

function isByokMessage(value: unknown): value is ByokMessage {
	if (!isObject(value) || typeof value.role !== "string") return false;
	if (value.role === "user") {
		return (
			typeof value.content === "string" &&
			(value.displayContent === undefined ||
				typeof value.displayContent === "string") &&
			(value.hidden === undefined || typeof value.hidden === "boolean") &&
			(value.attachments === undefined ||
				(Array.isArray(value.attachments) &&
					value.attachments.every(isAttachment)))
		);
	}
	if (value.role === "assistant") {
		return (
			typeof value.content === "string" &&
			(value.hidden === undefined || typeof value.hidden === "boolean") &&
			(value.providerMetadata === undefined ||
				typeof value.providerMetadata === "string") &&
			Array.isArray(value.toolCalls) &&
			value.toolCalls.every(
				(call) =>
					isObject(call) &&
					typeof call.id === "string" &&
					typeof call.name === "string",
			)
		);
	}
	if (value.role === "tool") {
		return (
			Array.isArray(value.results) &&
			value.results.every(
				(result) =>
					isObject(result) &&
					typeof result.id === "string" &&
					typeof result.name === "string" &&
					typeof result.output === "string",
			)
		);
	}
	return false;
}

function isAttachment(value: unknown): boolean {
	return (
		isObject(value) &&
		typeof value.path === "string" &&
		typeof value.mediaType === "string" &&
		(value.base64 === undefined || typeof value.base64 === "string") &&
		(value.text === undefined || typeof value.text === "string")
	);
}
