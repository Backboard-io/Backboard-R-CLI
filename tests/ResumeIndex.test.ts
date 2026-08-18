import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	lookupResumeEntry,
	registerResumeIds,
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

	it("ignores missing and malformed index files", async () => {
		const homeDir = await mkdtemp(join(tmpdir(), "resume-index-home-"));
		expect(await lookupResumeEntry("missing", homeDir)).toBeNull();
	});
});
