import { describe, expect, it } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathsInsideCwd } from "../src/core/permissions/pathsInside.ts";

describe("pathsInsideCwd", () => {
	it("accepts paths inside cwd and rejects ../ escapes", () => {
		expect(pathsInsideCwd(["src/a.ts"], "/project")).toBe(true);
		expect(pathsInsideCwd(["../elsewhere/a.ts"], "/project")).toBe(false);
		expect(pathsInsideCwd(["src/a.ts", "../evil"], "/project")).toBe(false);
	});

	it("rejects a path that traverses a symlink pointing outside cwd", async () => {
		const root = await mkdtemp(join(tmpdir(), "q-cwd-"));
		const outside = await mkdtemp(join(tmpdir(), "q-outside-"));
		await writeFile(join(outside, "secret.txt"), "x");
		// A symlink inside cwd pointing outside: `link` is lexically inside cwd.
		await symlink(outside, join(root, "link"));

		// Lexically inside cwd, but really resolves into `outside` → rejected.
		expect(pathsInsideCwd(["link/secret.txt"], root)).toBe(false);
		// A genuinely-inside path still passes.
		expect(pathsInsideCwd(["real/new.txt"], root)).toBe(true);
	});
});
