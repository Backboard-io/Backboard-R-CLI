import { describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	enabledProviderKeys,
	providerKeysPath,
	readProviderKeys,
	removeProviderKey,
	setProviderKey,
	setProviderKeyEnabled,
	unreadableProviderKeys,
	upgradeProviderKeyFile,
} from "../src/core/keys/ProviderKeyStore.ts";
import { maskProviderKey } from "../src/core/keys/ProviderKeyTypes.ts";

async function tempHome(): Promise<string> {
	return mkdtemp(path.join(os.tmpdir(), "byok-keys-"));
}

describe("provider key store", () => {
	it("returns an empty file when nothing is saved", async () => {
		expect(readProviderKeys(await tempHome())).toEqual({});
	});

	it("round-trips a saved key as enabled", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-example", home);

		const keys = readProviderKeys(home);
		expect(keys.anthropic?.key).toBe("sk-ant-example");
		expect(keys.anthropic?.enabled).toBe(true);
		expect(keys.anthropic?.addedAt).toBeString();
	});

	it("round-trips an OpenRouter key", async () => {
		const home = await tempHome();
		await setProviderKey("openrouter", "sk-or-v1-example", home);

		expect(readProviderKeys(home).openrouter).toMatchObject({
			key: "sk-or-v1-example",
			enabled: true,
		});
	});

	it("writes the key file owner-only", async () => {
		const home = await tempHome();
		await setProviderKey("openai", "sk-example", home);

		const mode = statSync(providerKeysPath(home)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("keeps a disabled key on disk but out of the enabled set", async () => {
		const home = await tempHome();
		await setProviderKey("google", "AIza-example", home);
		await setProviderKeyEnabled("google", false, home);

		expect(readProviderKeys(home).google?.key).toBe("AIza-example");
		expect(enabledProviderKeys(readProviderKeys(home))).toEqual([]);
	});

	it("re-enables a key when it is added again", async () => {
		const home = await tempHome();
		await setProviderKey("openai", "sk-first", home);
		await setProviderKeyEnabled("openai", false, home);
		await setProviderKey("openai", "sk-second", home);

		expect(readProviderKeys(home).openai).toMatchObject({
			key: "sk-second",
			enabled: true,
		});
	});

	it("lists only enabled keys", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-a", home);
		await setProviderKey("openai", "sk-o", home);
		await setProviderKeyEnabled("openai", false, home);

		expect(enabledProviderKeys(readProviderKeys(home))).toEqual([
			{ provider: "anthropic", key: "sk-ant-a" },
		]);
	});

	it("removes a key", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-a", home);
		await removeProviderKey("anthropic", home);

		expect(readProviderKeys(home)).toEqual({});
	});

	it("preserves custom providers and ignores malformed ids and entries", async () => {
		const home = await tempHome();
		await Bun.write(
			providerKeysPath(home),
			JSON.stringify({
				anthropic: { key: "sk-ant-ok", enabled: true },
				bogus: { key: "sk-nope", enabled: true },
				"not a provider": { key: "sk-invalid", enabled: true },
				openai: { enabled: true },
				google: "not-an-object",
			}),
		);

		expect(Object.keys(readProviderKeys(home))).toEqual(["anthropic", "bogus"]);
	});

	it("never writes the secret in readable form", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-super-secret-value", home);

		const raw = await Bun.file(providerKeysPath(home)).text();
		expect(raw).not.toContain("sk-ant-super-secret-value");
		expect(raw).not.toContain("sk-ant");
		expect(JSON.parse(raw).version).toBe(2);
	});

	it("reads back an encrypted key on the same machine", async () => {
		const home = await tempHome();
		await setProviderKey("openai", "sk-roundtrip-value", home);

		expect(readProviderKeys(home).openai?.key).toBe("sk-roundtrip-value");
	});

	it("upgrades a legacy plaintext file in place, preserving the keys", async () => {
		const home = await tempHome();
		await Bun.write(
			providerKeysPath(home),
			JSON.stringify({
				anthropic: {
					key: "sk-ant-legacy",
					enabled: false,
					addedAt: "2026-01-01T00:00:00.000Z",
				},
			}),
		);

		expect(await upgradeProviderKeyFile(home)).toBe(true);

		const raw = await Bun.file(providerKeysPath(home)).text();
		expect(raw).not.toContain("sk-ant-legacy");
		expect(readProviderKeys(home).anthropic).toMatchObject({
			key: "sk-ant-legacy",
			enabled: false,
			addedAt: "2026-01-01T00:00:00.000Z",
		});
		// Already current: nothing more to do.
		expect(await upgradeProviderKeyFile(home)).toBe(false);
	});

	it("treats a key encrypted under a different salt as absent", async () => {
		const home = await tempHome();
		await setProviderKey("google", "AIza-original", home);

		// Simulates the file being copied from another machine: the ciphertext
		// survives, the salt it was derived against does not match.
		const file = JSON.parse(await Bun.file(providerKeysPath(home)).text());
		file.salt = Buffer.from("a-different-salt-entirely-32bytes").toString(
			"base64",
		);
		await Bun.write(providerKeysPath(home), JSON.stringify(file));

		expect(readProviderKeys(home).google).toBeUndefined();
	});

	it("detects tampering with the ciphertext", async () => {
		const home = await tempHome();
		await setProviderKey("openai", "sk-authentic", home);

		const file = JSON.parse(await Bun.file(providerKeysPath(home)).text());
		const original = file.keys.openai.secret.ciphertext as string;
		file.keys.openai.secret.ciphertext = Buffer.from(
			`${Buffer.from(original, "base64").toString("hex")}00`,
			"hex",
		).toString("base64");
		await Bun.write(providerKeysPath(home), JSON.stringify(file));

		expect(readProviderKeys(home).openai).toBeUndefined();
	});

	it("keeps other providers decryptable when one is rewritten", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-first", home);
		await setProviderKey("openai", "sk-second", home);
		await setProviderKeyEnabled("anthropic", false, home);

		const keys = readProviderKeys(home);
		expect(keys.anthropic?.key).toBe("sk-ant-first");
		expect(keys.openai?.key).toBe("sk-second");
	});

	it("preserves concurrent updates from separate CLI processes", async () => {
		const home = await tempHome();
		const storeUrl = new URL(
			"../src/core/keys/ProviderKeyStore.ts",
			import.meta.url,
		).href;
		const updates = [
			["anthropic", "sk-ant-concurrent"],
			["openai", "sk-openai-concurrent"],
			["google", "AIza-concurrent"],
		] as const;
		const processes = updates.map(([provider, key]) =>
			Bun.spawn({
				cmd: [
					process.execPath,
					"-e",
					`import { setProviderKey } from ${JSON.stringify(storeUrl)}; await setProviderKey(${JSON.stringify(provider)}, ${JSON.stringify(key)}, ${JSON.stringify(home)});`,
				],
				stderr: "pipe",
			}),
		);
		for (const process of processes) {
			const exitCode = await process.exited;
			if (exitCode !== 0) {
				throw new Error(await new Response(process.stderr).text());
			}
		}

		expect(readProviderKeys(home)).toMatchObject({
			anthropic: { key: "sk-ant-concurrent" },
			openai: { key: "sk-openai-concurrent" },
			google: { key: "AIza-concurrent" },
		});
	});

	it("does not rewrite the key file for no-op mutations", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-stable", home);
		const before = await readFile(providerKeysPath(home), "utf8");

		await setProviderKeyEnabled("anthropic", true, home);
		await removeProviderKey("openai", home);

		expect(await readFile(providerKeysPath(home), "utf8")).toBe(before);
	});

	it("treats a corrupt key file as empty rather than throwing", async () => {
		const home = await tempHome();
		await Bun.write(providerKeysPath(home), "{ not json");

		expect(readProviderKeys(home)).toEqual({});
	});

	it("masks secrets to a recognizable prefix and suffix", () => {
		expect(maskProviderKey("sk-ant-api03-abcdefghijklmnop4f2a")).toBe(
			"sk-ant-…4f2a",
		);
		expect(maskProviderKey("short")).not.toContain("short");
	});
});

describe("undecryptable keys", () => {
	// Dropping a key silently is indistinguishable from never having saved one:
	// the first sign would be a failed request much later.
	it("reports a key whose ciphertext cannot be decrypted", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-example", home);

		// Simulate a file copied from another machine: the salt no longer
		// matches the key material the ciphertext was written under.
		const file = providerKeysPath(home);
		const parsed = JSON.parse(await readFile(file, "utf8"));
		parsed.salt = "0".repeat(32);
		await writeFile(file, JSON.stringify(parsed), "utf8");

		expect(readProviderKeys(home).anthropic).toBeUndefined();
		expect(unreadableProviderKeys(home)).toEqual(["anthropic"]);
	});

	it("reports nothing when every key reads back", async () => {
		const home = await tempHome();
		await setProviderKey("anthropic", "sk-ant-example", home);

		expect(unreadableProviderKeys(home)).toEqual([]);
	});
});
