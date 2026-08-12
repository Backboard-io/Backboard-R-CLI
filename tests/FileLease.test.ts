import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireFileLease } from "../src/utils/FileLease.ts";

const OPTIONS = {
	label: "test lease",
	timeoutMs: 30,
	retryMs: 5,
	invalidOwnerStaleMs: 10,
};

describe("FileLease", () => {
	it("does not release a lock now owned by another token", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		const lease = await acquireFileLease(lock, OPTIONS);
		await writeFile(
			lock,
			JSON.stringify({
				token: "new-owner",
				pid: process.pid,
				createdAt: Date.now(),
			}),
			"utf8",
		);

		await lease.release();

		expect(await readFile(lock, "utf8")).toContain("new-owner");
	});

	it("reclaims a lease whose process is no longer alive", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		await writeFile(
			lock,
			JSON.stringify({
				token: "dead-owner",
				pid: 2_147_483_647,
				createdAt: Date.now(),
			}),
			"utf8",
		);

		const lease = await acquireFileLease(lock, OPTIONS);

		expect(lease.token).not.toBe("dead-owner");
		await lease.release();
	});

	it("does not steal a lease from a live process", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		const lease = await acquireFileLease(lock, OPTIONS);

		await expect(acquireFileLease(lock, OPTIONS)).rejects.toThrow(
			"Another CLI process may still be using it",
		);
		await lease.release();
	});

	it("recovers a reclaim marker whose owner process died", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		await mkdir(`${lock}.reclaim`);
		await writeFile(
			`${lock}.reclaim/owner.json`,
			JSON.stringify({
				token: "dead-reclaimer",
				pid: 2_147_483_647,
				createdAt: Date.now(),
			}),
			"utf8",
		);

		const lease = await acquireFileLease(lock, OPTIONS);

		expect(lease.token).not.toBe("dead-reclaimer");
		await lease.release();
	});

	it("reclaims a recycled PID whose process identity no longer matches", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		await writeFile(
			lock,
			JSON.stringify({
				token: "recycled-pid-owner",
				pid: process.pid,
				createdAt: Date.now(),
				processIdentity: "a different process start",
			}),
			"utf8",
		);

		const lease = await acquireFileLease(lock, OPTIONS);

		expect(lease.token).not.toBe("recycled-pid-owner");
		await lease.release();
	});

	it("reclaims a legacy lease created before the current PID started", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "file-lease-"));
		const lock = path.join(root, "lock");
		await writeFile(
			lock,
			JSON.stringify({
				token: "legacy-recycled-pid",
				pid: process.pid,
				createdAt: 1,
			}),
			"utf8",
		);

		const lease = await acquireFileLease(lock, OPTIONS);

		expect(lease.token).not.toBe("legacy-recycled-pid");
		await lease.release();
	});
});
