import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isLocalResumeId,
	isRemoteResumeId,
	resolveLocalResumeBootstrap,
} from "../src/core/session/ResumeBootstrap.ts";
import { SessionStore } from "../src/core/session/SessionStore.ts";
import { ByokConversationStore } from "../src/providers/byok/ByokConversationStore.ts";

describe("resolveLocalResumeBootstrap", () => {
	it("finds a local BYOK conversation by thread or session ID", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-bootstrap-"));
		const store = new ByokConversationStore(cwd);
		await store.save(
			{
				version: 1,
				revision: 0,
				threadId: "byok_d9c35862",
				sessionId: "sess_1234abcd",
				sessionRoot: "",
				provider: "anthropic",
				model: "claude-test",
				systemPrompt: "test",
				createdAt: "2026-08-18T10:00:00Z",
				updatedAt: "2026-08-18T10:00:00Z",
				messages: [],
			},
			0,
		);

		for (const id of ["byok_d9c35862", "sess_1234abcd"]) {
			expect(await resolveLocalResumeBootstrap(cwd, id)).toEqual({
				kind: "byok",
				threadId: "byok_d9c35862",
				sessionId: "sess_1234abcd",
				model: { provider: "anthropic", model: "claude-test" },
			});
		}
	});

	it("does not treat a namespaced but unknown ID as a valid resume", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-bootstrap-"));
		expect(await resolveLocalResumeBootstrap(cwd, "byok_deadbeef")).toBeNull();
		expect(await resolveLocalResumeBootstrap(cwd, "sess_deadbeef")).toBeNull();
	});

	it("resolves a local-only session from its metadata", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-bootstrap-"));
		const session = new SessionStore("sess_deadbeef", cwd);
		await session.init({
			sessionId: "sess_deadbeef",
			createdAt: "2026-08-18T10:00:00Z",
			cwd,
			model: "openai/gpt-test",
			profile: "coding",
		});
		expect(await resolveLocalResumeBootstrap(cwd, "sess_deadbeef")).toEqual({
			kind: "session",
			sessionId: "sess_deadbeef",
			model: { provider: "openai", model: "gpt-test" },
		});
	});

	it("rejects session metadata owned by a different ID", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-bootstrap-"));
		const session = new SessionStore("sess_deadbeef", cwd);
		await session.init({
			sessionId: "sess_deadbeef",
			createdAt: "2026-08-18T10:00:00Z",
			cwd,
			model: "openai/gpt-test",
			profile: "coding",
		});
		await writeFile(
			session.paths.meta,
			JSON.stringify({ sessionId: "sess_attacker", model: "openai/gpt-test" }),
		);
		expect(await resolveLocalResumeBootstrap(cwd, "sess_deadbeef")).toBeNull();
	});

	it("recognizes only standardized local ID shapes", () => {
		expect(isLocalResumeId("byok_deadbeef")).toBe(true);
		expect(isLocalResumeId("sess_deadbeef")).toBe(true);
		expect(isLocalResumeId("thread_remote")).toBe(false);
		expect(isLocalResumeId("../sess_deadbeef")).toBe(false);
		expect(isRemoteResumeId("thread_remote")).toBe(true);
		expect(isRemoteResumeId("byok_deadbeef")).toBe(false);
		expect(isRemoteResumeId("sess_deadbeef")).toBe(false);
		expect(isRemoteResumeId(" ")).toBe(false);
		expect(isLocalResumeId("SESS_DEADBEEF")).toBe(false);
		expect(isLocalResumeId("sess_DEADBEEF")).toBe(false);
		expect(isLocalResumeId("sess_deadbegg")).toBe(false);
	});

	it("ignores an unsafe indexed session hint", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "resume-bootstrap-"));
		expect(
			await resolveLocalResumeBootstrap(
				cwd,
				"byok_deadbeef",
				"../../../../etc",
			),
		).toBeNull();
	});
});
