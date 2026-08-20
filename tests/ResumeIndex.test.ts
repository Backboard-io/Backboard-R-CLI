import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	lookupResumeEntry,
	registerResumeIds,
	resumeIndexPath,
} from "../src/core/session/ResumeIndex.ts";

describe("resume index", () => {
	it("maps both session and thread IDs to their workspace", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await registerResumeIds(
			{
				cwd: "./workspace",
				sessionId: "sess_1234abcd",
				threadId: "byok_d9c35862",
			},
			homeDir,
		);
		const expected = {
			cwd: resolve("./workspace"),
			sessionId: "sess_1234abcd",
			threadId: "byok_d9c35862",
		};
		expect(await lookupResumeEntry("sess_1234abcd", homeDir)).toMatchObject(
			expected,
		);
		expect(await lookupResumeEntry("byok_d9c35862", homeDir)).toMatchObject(
			expected,
		);
	});

	it("merges concurrent registrations without losing entries", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await Promise.all([
			registerResumeIds({ cwd: "/one", sessionId: "sess_11111111" }, homeDir),
			registerResumeIds({ cwd: "/two", sessionId: "sess_22222222" }, homeDir),
		]);
		expect((await lookupResumeEntry("sess_11111111", homeDir))?.cwd).toBe(
			"/one",
		);
		expect((await lookupResumeEntry("sess_22222222", homeDir))?.cwd).toBe(
			"/two",
		);
	});

	it("preserves the thread mapping during session-only registration", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await registerResumeIds(
			{
				cwd: "/workspace",
				sessionId: "sess_1234abcd",
				threadId: "thread_remote",
			},
			homeDir,
		);
		await registerResumeIds(
			{ cwd: "/workspace", sessionId: "sess_1234abcd" },
			homeDir,
		);
		expect(await lookupResumeEntry("sess_1234abcd", homeDir)).toMatchObject({
			threadId: "thread_remote",
		});
		expect(await lookupResumeEntry("thread_remote", homeDir)).toBeNull();
	});

	it("clears the previous session owner when a BYOK thread alias moves", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await registerResumeIds(
			{
				cwd: "/workspace",
				sessionId: "sess_11111111",
				threadId: "byok_deadbeef",
			},
			homeDir,
		);
		await registerResumeIds(
			{
				cwd: "/workspace",
				sessionId: "sess_22222222",
				threadId: "byok_deadbeef",
			},
			homeDir,
		);
		expect(
			(await lookupResumeEntry("sess_11111111", homeDir))?.threadId,
		).toBeUndefined();
		expect(await lookupResumeEntry("byok_deadbeef", homeDir)).toMatchObject({
			sessionId: "sess_22222222",
		});
	});

	it("ignores entries with unsafe session IDs or relative workspaces", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await mkdir(join(homeDir, ".backboard"), { recursive: true });
		await writeFile(
			resumeIndexPath(homeDir),
			JSON.stringify({
				version: 1,
				entries: {
					byok_deadbeef: {
						cwd: "/workspace",
						sessionId: "../../../../etc",
						threadId: "byok_deadbeef",
						updatedAt: "2026-08-18T10:00:00Z",
					},
					sess_1234abcd: {
						cwd: "relative/workspace",
						sessionId: "sess_1234abcd",
						updatedAt: "2026-08-18T10:00:00Z",
					},
				},
			}),
		);
		expect(await lookupResumeEntry("byok_deadbeef", homeDir)).toBeNull();
		expect(await lookupResumeEntry("sess_1234abcd", homeDir)).toBeNull();
	});

	it("rejects invalid IDs before writing the index", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		await expect(
			registerResumeIds(
				{ cwd: "/workspace", sessionId: "../../../../etc" },
				homeDir,
			),
		).rejects.toThrow("Invalid local session ID");
		expect(
			await readFile(resumeIndexPath(homeDir), "utf8").catch(() => ""),
		).toBe("");
	});

	it("ignores missing and malformed index files", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		expect(await lookupResumeEntry("missing", homeDir)).toBeNull();
	});
});
