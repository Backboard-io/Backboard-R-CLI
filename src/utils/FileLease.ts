import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileExists } from "./fs.ts";
import {
	isProcessAlive,
	parseProcessIdentity,
	processIdentitiesMatch,
	processIdentity,
} from "./process.ts";

let currentProcessIdentity: Promise<string | null> | undefined;

export interface FileLeaseOptions {
	label: string;
	timeoutMs: number;
	retryMs: number;
	invalidOwnerStaleMs: number;
}

interface LeaseRecord {
	token: string;
	pid: number;
	createdAt: number;
	processIdentity?: string;
}

export interface FileLease {
	readonly token: string;
	release(): Promise<void>;
}

export async function acquireFileLease(
	path: string,
	options: FileLeaseOptions,
): Promise<FileLease> {
	const reclaimPath = `${path}.reclaim`;
	const deadline = Date.now() + options.timeoutMs;
	const identityCache = new Map<string, string | null>();
	for (;;) {
		await recoverAbandonedReclaim(
			reclaimPath,
			options.invalidOwnerStaleMs,
			identityCache,
		);
		if (!(await fileExists(reclaimPath))) {
			const lease = await tryCreateLease(path);
			if (lease) return lease;
		}

		const existing = await readLease(path);
		if (existing && !(await leaseOwnerIsAlive(existing, identityCache))) {
			const reclaimed = await tryReclaim(path, reclaimPath, existing.token);
			if (reclaimed) continue;
		} else if (!existing) {
			const info = await stat(path).catch(() => null);
			if (
				info &&
				Date.now() - info.mtimeMs > options.invalidOwnerStaleMs &&
				(await tryReclaim(path, reclaimPath, null))
			) {
				continue;
			}
		}

		if (Date.now() >= deadline) {
			throw new Error(
				`Timed out waiting for ${options.label}. Another CLI process may still be using it.`,
			);
		}
		await Bun.sleep(options.retryMs);
	}
}

async function tryCreateLease(path: string): Promise<FileLease | null> {
	const token = randomUUID();
	const record = await createLeaseRecord(token);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "wx");
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") return null;
		if (handle) await rm(path, { force: true }).catch(() => undefined);
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
	return {
		token,
		release: async () => {
			const current = await readLease(path);
			if (current?.token !== token) return;
			await rm(path, { force: true }).catch(() => undefined);
		},
	};
}

async function tryReclaim(
	path: string,
	reclaimPath: string,
	expectedToken: string | null,
): Promise<boolean> {
	const marker = await tryCreateReclaimMarker(reclaimPath);
	if (!marker) return false;
	try {
		const current = await readLease(path);
		if ((current?.token ?? null) !== expectedToken) return false;
		await rm(path, { force: true });
		return true;
	} finally {
		await marker.release();
	}
}

async function tryCreateReclaimMarker(path: string): Promise<FileLease | null> {
	const token = randomUUID();
	const record = await createLeaseRecord(token);
	const ownerPath = `${path}/owner.json`;
	try {
		await mkdir(path);
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") return null;
		throw error;
	}
	try {
		await writeLease(ownerPath, record);
	} catch (error) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	return {
		token,
		release: async () => {
			const current = await readLease(ownerPath);
			if (current?.token !== token) return;
			await rm(path, { recursive: true, force: true }).catch(() => undefined);
		},
	};
}

async function recoverAbandonedReclaim(
	path: string,
	invalidOwnerStaleMs: number,
	identityCache: Map<string, string | null>,
): Promise<void> {
	const owner = await readLease(`${path}/owner.json`);
	if (owner) {
		if (!(await leaseOwnerIsAlive(owner, identityCache))) {
			await rm(path, { recursive: true, force: true }).catch(() => undefined);
		}
		return;
	}
	const info = await stat(path).catch(() => null);
	if (info && Date.now() - info.mtimeMs > invalidOwnerStaleMs) {
		await rm(path, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function writeLease(path: string, record: LeaseRecord): Promise<void> {
	await writeFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

async function createLeaseRecord(token: string): Promise<LeaseRecord> {
	currentProcessIdentity ??= processIdentity(process.pid);
	const identity = await currentProcessIdentity;
	return {
		token,
		pid: process.pid,
		createdAt: Date.now(),
		...(identity ? { processIdentity: identity } : {}),
	};
}

async function readLease(path: string): Promise<LeaseRecord | null> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (
			typeof value !== "object" ||
			value === null ||
			typeof (value as LeaseRecord).token !== "string" ||
			typeof (value as LeaseRecord).pid !== "number" ||
			typeof (value as LeaseRecord).createdAt !== "number" ||
			((value as LeaseRecord).processIdentity !== undefined &&
				typeof (value as LeaseRecord).processIdentity !== "string")
		) {
			return null;
		}
		return value as LeaseRecord;
	} catch {
		return null;
	}
}

async function leaseOwnerIsAlive(
	record: LeaseRecord,
	identityCache: Map<string, string | null>,
): Promise<boolean> {
	if (!isProcessAlive(record.pid)) return false;
	const cacheKey = `${record.pid}:${record.token}`;
	let identity = identityCache.get(cacheKey);
	if (identity === undefined) {
		identity = await processIdentity(record.pid);
		identityCache.set(cacheKey, identity);
	}
	if (record.processIdentity) {
		return (
			identity === null ||
			processIdentitiesMatch(identity, record.processIdentity)
		);
	}
	if (!identity) return true;
	const processStartedAt = parseProcessIdentity(identity);
	return (
		!Number.isFinite(processStartedAt) ||
		processStartedAt <= record.createdAt + 2_000
	);
}
