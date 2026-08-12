import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendAllowRule,
	loadPermissionSettings,
} from "../src/core/permissions/settings.ts";

async function tempProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "q-perm-settings-"));
	// A .git dir makes findRepoRoot treat the temp dir as the project root.
	await mkdir(join(dir, ".git"), { recursive: true });
	return dir;
}

describe("permission settings", () => {
	it("returns defaults when no settings file exists", async () => {
		const cwd = await tempProject();
		expect(loadPermissionSettings(cwd)).toEqual({
			allow: [],
			deny: [],
			ask: [],
		});
	});

	it("loads the permissions block", async () => {
		const cwd = await tempProject();
		await mkdir(join(cwd, ".backboard"), { recursive: true });
		await writeFile(
			join(cwd, ".backboard", "settings.json"),
			JSON.stringify({
				permissions: {
					mode: "acceptEdits",
					allow: ["execute(bun test:*)"],
					deny: ["execute(git push:*)"],
				},
			}),
		);
		const settings = loadPermissionSettings(cwd);
		expect(settings.mode).toBe("acceptEdits");
		expect(settings.allow).toEqual(["execute(bun test:*)"]);
		expect(settings.deny).toEqual(["execute(git push:*)"]);
		expect(settings.ask).toEqual([]);
	});

	it("treats a corrupt file as empty settings", async () => {
		const cwd = await tempProject();
		await mkdir(join(cwd, ".backboard"), { recursive: true });
		await writeFile(join(cwd, ".backboard", "settings.json"), "{not json");
		expect(loadPermissionSettings(cwd)).toEqual({
			allow: [],
			deny: [],
			ask: [],
		});
	});

	it("appendAllowRule creates the file and preserves other keys", async () => {
		const cwd = await tempProject();
		await mkdir(join(cwd, ".backboard"), { recursive: true });
		await writeFile(
			join(cwd, ".backboard", "settings.json"),
			JSON.stringify({
				other: { keep: true },
				permissions: { allow: ["read"] },
			}),
		);
		appendAllowRule(cwd, "execute(bun test:*)");
		const parsed = JSON.parse(
			await readFile(join(cwd, ".backboard", "settings.json"), "utf8"),
		);
		expect(parsed.other).toEqual({ keep: true });
		expect(parsed.permissions.allow).toEqual(["read", "execute(bun test:*)"]);
	});

	it("appendAllowRule does not duplicate an existing rule", async () => {
		const cwd = await tempProject();
		appendAllowRule(cwd, "execute(bun test:*)");
		appendAllowRule(cwd, "execute(bun test:*)");
		expect(loadPermissionSettings(cwd).allow).toEqual(["execute(bun test:*)"]);
	});
});
