import { describe, expect, test } from "bun:test";
import {
	type ClipboardCleanupDeps,
	type ClipboardImageDeps,
	cleanupClipboardImages,
	readClipboardImage,
	sweepStaleClipboardImages,
} from "../src/core/attachments/clipboardImage.ts";

function fakeDeps(
	options: {
		platform?: NodeJS.Platform;
		execCode?: number;
		sizeBytes?: number;
		statThrows?: boolean;
	} = {},
) {
	const execCalls: { command: string; args: string[] }[] = [];
	const unlinked: string[] = [];
	let tick = 0;
	const deps: ClipboardImageDeps = {
		platform: options.platform ?? "darwin",
		tmpdir: () => "/tmp",
		now: () => {
			tick += 1;
			return tick;
		},
		exec: async (command, args) => {
			execCalls.push({ command, args });
			return { code: options.execCode ?? 0 };
		},
		statSync: () => {
			if (options.statThrows) throw new Error("ENOENT");
			return { size: options.sizeBytes ?? 100 };
		},
		unlinkSync: (path) => {
			unlinked.push(path);
		},
	};
	return { deps, execCalls, unlinked };
}

describe("readClipboardImage", () => {
	test("returns a staged temp png when the clipboard has an image", async () => {
		const { deps, execCalls } = fakeDeps({ sizeBytes: 1234 });
		const result = await readClipboardImage(deps);
		expect(result.kind).toBe("image");
		if (result.kind === "image") {
			expect(result.file.filePath).toMatch(
				/^\/tmp\/backboard-clipboard-\d+-\d+\.png$/,
			);
			expect(result.file.fileName).toBe(
				result.file.filePath.replace("/tmp/", ""),
			);
			expect(result.file.sizeBytes).toBe(1234);
		}
		expect(execCalls).toHaveLength(1);
		expect(execCalls[0]?.command).toBe("osascript");
	});

	test("returns none when the save command fails", async () => {
		const { deps, unlinked } = fakeDeps({ execCode: 1 });
		const result = await readClipboardImage(deps);
		expect(result).toEqual({ kind: "none" });
		expect(unlinked).toHaveLength(1);
	});

	test("returns none and deletes a zero-byte file", async () => {
		const { deps, unlinked } = fakeDeps({ sizeBytes: 0 });
		const result = await readClipboardImage(deps);
		expect(result).toEqual({ kind: "none" });
		expect(unlinked).toHaveLength(1);
	});

	test("returns too-large and deletes an oversized image", async () => {
		const { deps, unlinked } = fakeDeps({ sizeBytes: 11 * 1024 * 1024 });
		const result = await readClipboardImage(deps);
		expect(result).toEqual({ kind: "too-large" });
		expect(unlinked).toHaveLength(1);
	});

	test("returns none when the written file cannot be statted", async () => {
		const { deps } = fakeDeps({ statThrows: true });
		const result = await readClipboardImage(deps);
		expect(result).toEqual({ kind: "none" });
	});

	test("returns none without running commands on unsupported platforms", async () => {
		const { deps, execCalls } = fakeDeps({ platform: "freebsd" });
		const result = await readClipboardImage(deps);
		expect(result).toEqual({ kind: "none" });
		expect(execCalls).toHaveLength(0);
	});

	test("uses distinct temp paths across calls", async () => {
		const { deps } = fakeDeps();
		const first = await readClipboardImage(deps);
		const second = await readClipboardImage(deps);
		if (first.kind === "image" && second.kind === "image") {
			expect(first.file.filePath).not.toBe(second.file.filePath);
		} else {
			throw new Error("expected both reads to return images");
		}
	});

	test("uses platform-specific clipboard commands", async () => {
		const linux = fakeDeps({ platform: "linux" });
		await readClipboardImage(linux.deps);
		expect(linux.execCalls[0]?.command).toBe("/bin/sh");
		expect(linux.execCalls[0]?.args[1]).toContain("xclip");

		const windows = fakeDeps({ platform: "win32" });
		await readClipboardImage(windows.deps);
		expect(windows.execCalls[0]?.command).toBe("powershell");
		expect(windows.execCalls[0]?.args[2]).toContain("Get-Clipboard");
	});

	test("passes the target path as an argument, not embedded in the script", async () => {
		const darwin = fakeDeps({ platform: "darwin" });
		await readClipboardImage(darwin.deps);
		const darwinArgs = darwin.execCalls[0]?.args ?? [];
		const darwinScript = darwinArgs.slice(0, -1).join("\n");
		expect(darwinScript).not.toContain("/tmp/backboard-clipboard-");
		expect(darwinArgs.at(-1)).toMatch(/^\/tmp\/backboard-clipboard-/);

		const linux = fakeDeps({ platform: "linux" });
		await readClipboardImage(linux.deps);
		const linuxArgs = linux.execCalls[0]?.args ?? [];
		expect(linuxArgs[1]).toContain('"$1"');
		expect(linuxArgs[1]).not.toContain("/tmp/backboard-clipboard-");
		expect(linuxArgs.at(-1)).toMatch(/^\/tmp\/backboard-clipboard-/);
	});
});

function fakeCleanupDeps(
	options: { files?: string[]; nowMs?: number; unlinkThrows?: boolean } = {},
) {
	const unlinked: string[] = [];
	const deps: ClipboardCleanupDeps = {
		tmpdir: () => "/tmp",
		now: () => options.nowMs ?? 0,
		readdirSync: () => options.files ?? [],
		unlinkSync: (path) => {
			if (options.unlinkThrows) throw new Error("EPERM");
			unlinked.push(path);
		},
	};
	return { deps, unlinked };
}

describe("cleanupClipboardImages", () => {
	test("deletes only clipboard temp files in the temp dir", () => {
		const { deps, unlinked } = fakeCleanupDeps();
		cleanupClipboardImages(
			[
				"/tmp/backboard-clipboard-1-1.png",
				"/tmp/user-photo.png",
				"/home/me/backboard-clipboard-2-1.png",
			],
			deps,
		);
		expect(unlinked).toEqual(["/tmp/backboard-clipboard-1-1.png"]);
	});

	test("swallows unlink errors", () => {
		const { deps } = fakeCleanupDeps({ unlinkThrows: true });
		expect(() =>
			cleanupClipboardImages(["/tmp/backboard-clipboard-1-1.png"], deps),
		).not.toThrow();
	});
});

describe("sweepStaleClipboardImages", () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	test("deletes stale clipboard temp files and leaves fresh or foreign ones", () => {
		const { deps, unlinked } = fakeCleanupDeps({
			files: [
				"backboard-clipboard-1000-1.png",
				`backboard-clipboard-${DAY_MS + 999}-1.png`,
				"backboard-clipboard-nonsense.png",
				"other-file.png",
			],
			nowMs: DAY_MS + 1000,
		});
		sweepStaleClipboardImages(deps);
		expect(unlinked).toEqual(["/tmp/backboard-clipboard-1000-1.png"]);
	});

	test("swallows readdir errors", () => {
		const { deps } = fakeCleanupDeps();
		deps.readdirSync = () => {
			throw new Error("ENOENT");
		};
		expect(() => sweepStaleClipboardImages(deps)).not.toThrow();
	});
});
