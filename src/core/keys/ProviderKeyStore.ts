import { readFileSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKBOARD_CONFIG_DIR_NAME } from "../../config/paths.ts";
import { acquireFileLease } from "../../utils/FileLease.ts";
import { writePrivateFileAtomic } from "../../utils/fs.ts";
import type { JsonValue } from "../../utils/JsonTypes.ts";
import {
	decryptSecret,
	encryptSecret,
	isEncryptedValue,
	newSalt,
} from "./KeyCipher.ts";
import {
	PROVIDER_KEY_LEASE_OPTIONS,
	PROVIDER_KEY_LEASE_SUFFIX,
} from "./ProviderKeyStore.constants.ts";
import {
	type ByokProviderId,
	isByokProviderId,
	type ProviderKeyFile,
	type ResolvedProviderKey,
	type StoredProviderKey,
} from "./ProviderKeyTypes.ts";

const KEYS_FILE_NAME = "keys.json";
/** v1 stored secrets in plaintext; v2 encrypts them. See KeyCipher. */
const CURRENT_VERSION = 2;

/**
 * Provider keys live in their own file, not config.json. `/model`, `/settings`,
 * and `/notify` rewrite config.json constantly; keeping secrets out of that
 * write path means a failed merge or a logged config dump can never leak them.
 *
 * Secrets in the file are encrypted at rest (see KeyCipher for the threat
 * model). Everything in this module works in plaintext `ProviderKeyFile`
 * values; encryption is applied on write and reversed on read, so no caller
 * has to know the file format.
 */
export function providerKeysPath(homeDir = os.homedir()): string {
	return path.join(homeDir, BACKBOARD_CONFIG_DIR_NAME, KEYS_FILE_NAME);
}

interface KeyFileShape {
	salt: string;
	keys: ProviderKeyFile;
	/** True when the file was read in the legacy plaintext format. */
	needsUpgrade: boolean;
	/**
	 * Providers whose saved key could not be decrypted. They are dropped rather
	 * than surfaced as broken, so the caller has to be told: otherwise the key
	 * appears to have vanished on its own and the first sign is a failed
	 * request much later.
	 */
	unreadable: ByokProviderId[];
}

function readKeyFile(homeDir: string): KeyFileShape {
	const file = providerKeysPath(homeDir);
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8")) as JsonValue;
	} catch {
		// Missing or corrupt: the CLI still has Backboard SSO and `/keys` to
		// repair things, so this must never be fatal.
		return { salt: newSalt(), keys: {}, needsUpgrade: false, unreadable: [] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { salt: newSalt(), keys: {}, needsUpgrade: false, unreadable: [] };
	}

	const root = parsed as Record<string, JsonValue | undefined>;
	const version = typeof root.version === "number" ? root.version : 1;
	const salt =
		typeof root.salt === "string" && root.salt ? root.salt : newSalt();
	// v1 held providers at the root; v2 nests them under `keys`.
	const source = version >= 2 ? root.keys : root;
	if (typeof source !== "object" || source === null || Array.isArray(source)) {
		return { salt, keys: {}, needsUpgrade: false, unreadable: [] };
	}

	const keys: ProviderKeyFile = {};
	const unreadable: ByokProviderId[] = [];
	for (const [provider, value] of Object.entries(source)) {
		if (!isByokProviderId(provider)) continue;
		const entry = readEntry(value, salt);
		if (entry) keys[provider] = entry;
		else if (isEncryptedEntry(value)) unreadable.push(provider);
	}
	return { salt, keys, needsUpgrade: version < CURRENT_VERSION, unreadable };
}

/** An entry that stored a secret, as opposed to a malformed or empty record. */
function isEncryptedEntry(value: JsonValue | undefined): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	return isEncryptedValue(
		(value as Record<string, JsonValue | undefined>).secret,
	);
}

function readEntry(
	value: JsonValue | undefined,
	salt: string,
): StoredProviderKey | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, JsonValue | undefined>;

	// v2: encrypted. A key that fails to decrypt (file copied from another
	// machine, tampered, changed machine identity) is treated as absent, so
	// `/keys` shows it as not set and the user can paste a fresh one.
	const secret = isEncryptedValue(record.secret)
		? decryptSecret(record.secret, salt)
		: typeof record.key === "string"
			? record.key.trim()
			: null;
	if (!secret) return null;

	return {
		key: secret,
		// Absent `enabled` means an older file wrote before toggles existed.
		enabled: typeof record.enabled === "boolean" ? record.enabled : true,
		addedAt:
			typeof record.addedAt === "string"
				? record.addedAt
				: new Date(0).toISOString(),
	};
}

export function readProviderKeys(homeDir = os.homedir()): ProviderKeyFile {
	return readKeyFile(homeDir).keys;
}

/**
 * Providers whose stored key is present but undecryptable - the file was copied
 * from another machine, tampered with, or the machine identity changed. Read at
 * startup so the user is told once, rather than discovering it when a request
 * fails.
 */
export function unreadableProviderKeys(
	homeDir = os.homedir(),
): ByokProviderId[] {
	return readKeyFile(homeDir).unreadable;
}

/**
 * Rewrites a legacy plaintext file as encrypted, in place. Called at startup so
 * an existing install stops storing readable secrets without the user having to
 * do anything. No-op on an already-current file.
 */
export async function upgradeProviderKeyFile(
	homeDir = os.homedir(),
): Promise<boolean> {
	return withProviderKeyLease(homeDir, async () => {
		const file = readKeyFile(homeDir);
		if (!file.needsUpgrade || Object.keys(file.keys).length === 0) return false;
		await saveProviderKeys(file.keys, homeDir, file.salt);
		return true;
	});
}

async function saveProviderKeys(
	keys: ProviderKeyFile,
	homeDir = os.homedir(),
	salt?: string,
): Promise<string> {
	const file = providerKeysPath(homeDir);
	const dir = path.dirname(file);
	// Reuse the existing salt so untouched entries stay decryptable; only a
	// brand-new file mints one.
	const activeSalt = salt ?? readKeyFile(homeDir).salt;

	const encrypted: Record<string, unknown> = {};
	for (const [provider, entry] of Object.entries(keys)) {
		if (!entry) continue;
		encrypted[provider] = {
			secret: encryptSecret(entry.key, activeSalt),
			enabled: entry.enabled,
			addedAt: entry.addedAt,
		};
	}

	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700).catch(() => undefined);
	await writePrivateFileAtomic(
		file,
		`${JSON.stringify(
			{ version: CURRENT_VERSION, salt: activeSalt, keys: encrypted },
			null,
			2,
		)}\n`,
	);

	return file;
}

async function withProviderKeyLease<T>(
	homeDir: string,
	action: () => Promise<T>,
): Promise<T> {
	const file = providerKeysPath(homeDir);
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const lease = await acquireFileLease(
		`${file}${PROVIDER_KEY_LEASE_SUFFIX}`,
		PROVIDER_KEY_LEASE_OPTIONS,
	);
	try {
		return await action();
	} finally {
		await lease.release();
	}
}

async function mutateProviderKeys(
	homeDir: string,
	mutate: (file: KeyFileShape) => ProviderKeyFile | null,
): Promise<ProviderKeyFile> {
	return withProviderKeyLease(homeDir, async () => {
		const file = readKeyFile(homeDir);
		const next = mutate(file);
		if (next === null) return file.keys;
		await saveProviderKeys(next, homeDir, file.salt);
		return next;
	});
}

export async function setProviderKey(
	provider: ByokProviderId,
	key: string,
	homeDir?: string,
	now = new Date(),
): Promise<ProviderKeyFile> {
	const targetHome = homeDir ?? os.homedir();
	return mutateProviderKeys(targetHome, (file) => ({
		...file.keys,
		[provider]: {
			key: key.trim(),
			// Adding a key is an explicit act of intent: it comes back enabled
			// even if a previous key for this provider was toggled off.
			enabled: true,
			addedAt: now.toISOString(),
		},
	}));
}

export async function setProviderKeyEnabled(
	provider: ByokProviderId,
	enabled: boolean,
	homeDir?: string,
): Promise<ProviderKeyFile> {
	const targetHome = homeDir ?? os.homedir();
	return mutateProviderKeys(targetHome, (file) => {
		const existing = file.keys[provider];
		if (!existing || existing.enabled === enabled) return null;
		return {
			...file.keys,
			[provider]: { ...existing, enabled },
		};
	});
}

export async function removeProviderKey(
	provider: ByokProviderId,
	homeDir?: string,
): Promise<ProviderKeyFile> {
	const targetHome = homeDir ?? os.homedir();
	return mutateProviderKeys(targetHome, (file) => {
		if (!file.keys[provider]) return null;
		const next = { ...file.keys };
		delete next[provider];
		return next;
	});
}

/** Enabled keys only - what model resolution and the BYOK client may use. */
export function enabledProviderKeys(
	keys: ProviderKeyFile,
): ResolvedProviderKey[] {
	const resolved: ResolvedProviderKey[] = [];
	for (const [provider, entry] of Object.entries(keys)) {
		if (!isByokProviderId(provider) || !entry?.enabled) continue;
		resolved.push({ provider, key: entry.key });
	}
	return resolved;
}
