import { execFileSync } from "node:child_process";
import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";

/**
 * Encryption at rest for saved provider keys.
 *
 * Threat model, stated plainly: the decryption key is derived from values
 * present on this machine, so anything running as this user can recover the
 * secret. This is not secrecy against local code - it is obstruction. What it
 * does buy is real:
 *
 *   - `cat ~/.backboard/keys.json` no longer prints a live API key, so a
 *     screen-share, a pasted terminal dump, or a screenshot leaks nothing.
 *   - A backup, sync folder, or dotfiles repo that sweeps up the file carries
 *     ciphertext that is useless on any other machine.
 *   - Grep-for-`sk-` malware and casual snooping both come up empty.
 *
 * What it does not buy: protection from a process running as this user that
 * knows where to look. Only an OS keychain gives that boundary.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypting to
 * garbage. The salt is stored alongside the ciphertext - salts are not secret,
 * they exist so two machines never derive the same key.
 */

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SCRYPT_COST = 2 ** 15;

export interface EncryptedValue {
	iv: string;
	tag: string;
	ciphertext: string;
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.iv === "string" &&
		typeof record.tag === "string" &&
		typeof record.ciphertext === "string"
	);
}

export function newSalt(): string {
	return randomBytes(32).toString("base64");
}

export function encryptSecret(plaintext: string, salt: string): EncryptedValue {
	const iv = randomBytes(IV_LENGTH);
	const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
	const ciphertext = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	return {
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		ciphertext: ciphertext.toString("base64"),
	};
}

/**
 * Returns null when the value cannot be decrypted - a file copied from another
 * machine, a changed machine identity, or tampering. Callers treat that as "no
 * key saved" so the CLI degrades to asking for it again instead of crashing.
 */
export function decryptSecret(
	value: EncryptedValue,
	salt: string,
): string | null {
	try {
		const decipher = createDecipheriv(
			"aes-256-gcm",
			deriveKey(salt),
			Buffer.from(value.iv, "base64"),
		);
		decipher.setAuthTag(Buffer.from(value.tag, "base64"));
		return Buffer.concat([
			decipher.update(Buffer.from(value.ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");
	} catch {
		return null;
	}
}

const derivedKeys = new Map<string, Buffer>();

// scrypt at this cost is ~100ms; startup reads keys on every run, so the
// derivation is memoized per salt for the life of the process.
function deriveKey(salt: string): Buffer {
	const cached = derivedKeys.get(salt);
	if (cached) return cached;
	const key = scryptSync(
		machineSecret(),
		Buffer.from(salt, "base64"),
		KEY_LENGTH,
		{
			N: SCRYPT_COST,
			r: 8,
			p: 1,
			// scrypt at N=2^15 needs more than node's default 32MB scratch buffer.
			maxmem: 64 * 1024 * 1024,
		},
	);
	derivedKeys.set(salt, key);
	return key;
}

let cachedMachineSecret: string | null = null;

/**
 * Machine-and-user bound input to the KDF. Binding to the user as well as the
 * host means one account's keys.json is inert in another account's hands even
 * on a shared box.
 */
function machineSecret(): string {
	if (cachedMachineSecret !== null) return cachedMachineSecret;
	const user = os.userInfo().username;
	cachedMachineSecret = `${machineId()}::${user}::backboard-cli-keys`;
	return cachedMachineSecret;
}

function machineId(): string {
	try {
		if (process.platform === "darwin") {
			const output = execFileSync(
				"/usr/sbin/ioreg",
				["-rd1", "-c", "IOPlatformExpertDevice"],
				{
					encoding: "utf8",
					timeout: 2_000,
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
			if (match?.[1]) return match[1];
		} else if (process.platform === "linux") {
			for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				try {
					const id = readFileSync(path, "utf8").trim();
					if (id) return id;
				} catch {
					// try the next path
				}
			}
		} else if (process.platform === "win32") {
			const output = execFileSync(
				"reg",
				[
					"query",
					"HKLM\\SOFTWARE\\Microsoft\\Cryptography",
					"/v",
					"MachineGuid",
				],
				{
					encoding: "utf8",
					timeout: 2_000,
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
			if (match?.[1]) return match[1];
		}
	} catch {
		// Fall through to the portable identity below.
	}
	// Weaker, but still host-specific, and it keeps BYOK working in containers
	// and stripped-down images that expose no machine id at all.
	return `${os.hostname()}::${os.homedir()}`;
}
