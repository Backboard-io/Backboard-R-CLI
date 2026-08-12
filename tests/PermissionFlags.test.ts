import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags } from "../src/config/flags.ts";
import { buildPermissionContext } from "../src/core/permissions/index.ts";

describe("--permission-mode flag", () => {
	it("parses the flag", () => {
		expect(parseFlags(["--permission-mode", "bypass"]).permissionMode).toBe(
			"bypass",
		);
		expect(parseFlags(["--permission-mode=acceptEdits"]).permissionMode).toBe(
			"acceptEdits",
		);
		expect(parseFlags([]).permissionMode).toBeUndefined();
	});
});

describe("buildPermissionContext", () => {
	it("flag beats settings mode; default is manual", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "perm-wire-"));
		await mkdir(join(cwd, ".git"), { recursive: true });
		await mkdir(join(cwd, ".backboard"), { recursive: true });
		await writeFile(
			join(cwd, ".backboard", "settings.json"),
			JSON.stringify({
				permissions: { mode: "acceptEdits", allow: ["execute(bun test:*)"] },
			}),
		);
		expect(buildPermissionContext(cwd, "bypass", true).mode).toBe("bypass");
		expect(buildPermissionContext(cwd, undefined, true).mode).toBe(
			"acceptEdits",
		);
		const fresh = await mkdtemp(join(tmpdir(), "perm-wire2-"));
		await mkdir(join(fresh, ".git"), { recursive: true });
		expect(buildPermissionContext(fresh, undefined, true).mode).toBe("manual");
	});

	it("loads rules from settings and carries interactivity", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "perm-wire3-"));
		await mkdir(join(cwd, ".git"), { recursive: true });
		await mkdir(join(cwd, ".backboard"), { recursive: true });
		await writeFile(
			join(cwd, ".backboard", "settings.json"),
			JSON.stringify({ permissions: { allow: ["execute(bun test:*)"] } }),
		);
		const context = buildPermissionContext(cwd, undefined, false);
		expect(context.rules.allow).toHaveLength(1);
		expect(context.interactive).toBe(false);
	});
});
