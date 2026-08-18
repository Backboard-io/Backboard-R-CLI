import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { qUserConfigDir } from "../../config/paths.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { writePrivateFileAtomic } from "../../utils/fs.ts";

const RESUME_INDEX_VERSION = 1;
const RESUME_INDEX_FILE = "session-index.json";
const RESUME_INDEX_LEASE_SUFFIX = ".lock";

export interface ResumeIndexEntry {
	cwd: string;
	sessionId: string;
	threadId?: string;
	updatedAt: string;
}

interface ResumeIndexFile {
	version: typeof RESUME_INDEX_VERSION;
	entries: Record<string, ResumeIndexEntry>;
}

export async function lookupResumeEntry(
	id: string,
	homeDir?: string,
): Promise<ResumeIndexEntry | null> {
	const normalized = id.trim();
	if (!normalized) return null;
	const file = await readResumeIndex(homeDir);
	return file.entries[normalized] ?? null;
}

export async function registerResumeIds(
	input: {
		cwd: string;
		sessionId: string;
		threadId?: string | null;
	},
	homeDir?: string,
): Promise<void> {
	const path = resumeIndexPath(homeDir);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const lease = await acquireFileLease(`${path}${RESUME_INDEX_LEASE_SUFFIX}`, {
		label: "session resume index",
		timeoutMs: 5_000,
		retryMs: 50,
		invalidOwnerStaleMs: 5_000,
	});
	try {
		const file = await readResumeIndex(homeDir);
		const entry: ResumeIndexEntry = {
			cwd: resolve(input.cwd),
			sessionId: input.sessionId,
			...(input.threadId ? { threadId: input.threadId } : {}),
			updatedAt: new Date().toISOString(),
		};
		file.entries[input.sessionId] = entry;
		if (input.threadId) file.entries[input.threadId] = entry;
		await writeResumeIndex(path, file);
	} finally {
		await lease.release();
	}
}

export function resumeIndexPath(homeDir?: string): string {
	return join(qUserConfigDir(homeDir), RESUME_INDEX_FILE);
}

async function readResumeIndex(homeDir?: string): Promise<ResumeIndexFile> {
	try {
		const value = JSON.parse(
			await readFile(resumeIndexPath(homeDir), "utf8"),
		) as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== RESUME_INDEX_VERSION ||
			!("entries" in value) ||
			typeof value.entries !== "object" ||
			value.entries === null
		) {
			return emptyIndex();
		}
		const entries: Record<string, ResumeIndexEntry> = {};
		for (const [id, entry] of Object.entries(value.entries)) {
			if (isResumeIndexEntry(entry)) entries[id] = entry;
		}
		return { version: RESUME_INDEX_VERSION, entries };
	} catch {
		return emptyIndex();
	}
}

async function writeResumeIndex(
	path: string,
	file: ResumeIndexFile,
): Promise<void> {
	await writePrivateFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
}

function emptyIndex(): ResumeIndexFile {
	return { version: RESUME_INDEX_VERSION, entries: {} };
}

function isResumeIndexEntry(value: unknown): value is ResumeIndexEntry {
	return (
		typeof value === "object" &&
		value !== null &&
		"cwd" in value &&
		typeof value.cwd === "string" &&
		"sessionId" in value &&
		typeof value.sessionId === "string" &&
		"updatedAt" in value &&
		typeof value.updatedAt === "string" &&
		(!("threadId" in value) ||
			value.threadId === undefined ||
			typeof value.threadId === "string")
	);
}
