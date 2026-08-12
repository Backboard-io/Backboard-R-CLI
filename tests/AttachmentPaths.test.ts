import { describe, expect, test } from "bun:test";
import {
	type AttachmentPathDeps,
	detectAttachmentPaste,
	expandAttachmentPath,
	tokenizePastedPaths,
} from "../src/core/attachments/attachmentPaths.ts";

describe("tokenizePastedPaths", () => {
	test("splits on unescaped whitespace", () => {
		expect(tokenizePastedPaths("/a/b.png /c/d.pdf")).toEqual([
			"/a/b.png",
			"/c/d.pdf",
		]);
	});

	test("keeps backslash-escaped spaces (iTerm/Terminal drag style)", () => {
		expect(tokenizePastedPaths("/Users/me/My\\ File.png")).toEqual([
			"/Users/me/My File.png",
		]);
	});

	test("handles single- and double-quoted paths", () => {
		expect(tokenizePastedPaths("'/tmp/a b.png' \"/tmp/c d.pdf\"")).toEqual([
			"/tmp/a b.png",
			"/tmp/c d.pdf",
		]);
	});

	test("splits newline-separated paths and trims CRLF", () => {
		expect(tokenizePastedPaths("/a/x.png\r\n/b/y.md\n")).toEqual([
			"/a/x.png",
			"/b/y.md",
		]);
	});

	test("empty and whitespace-only input yields no tokens", () => {
		expect(tokenizePastedPaths("")).toEqual([]);
		expect(tokenizePastedPaths("  \n\t")).toEqual([]);
	});
});

describe("expandAttachmentPath", () => {
	test("decodes file:// URLs with percent escapes", () => {
		expect(expandAttachmentPath("file:///tmp/My%20File.png", "/home/u")).toBe(
			"/tmp/My File.png",
		);
	});

	test("strips file://localhost prefix", () => {
		expect(expandAttachmentPath("file://localhost/tmp/a.png", "/home/u")).toBe(
			"/tmp/a.png",
		);
	});

	test("expands tilde", () => {
		expect(expandAttachmentPath("~/x.png", "/home/u")).toBe("/home/u/x.png");
		expect(expandAttachmentPath("~", "/home/u")).toBe("/home/u");
	});

	test("leaves plain paths untouched", () => {
		expect(expandAttachmentPath("/a/b.png", "/home/u")).toBe("/a/b.png");
	});
});

function fakeDeps(
	files: Record<string, { dir?: boolean; size?: number }>,
): AttachmentPathDeps {
	const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
	return {
		existsSync: (p) => p in files,
		statSync: (p) => {
			const f = files[p];
			if (!f) throw new Error(`no stat for ${p}`);
			return { isDirectory: () => f.dir === true, size: f.size ?? 10 };
		},
		readdirSync: (dir) =>
			Object.keys(files)
				.filter((p) => p !== dir && parentOf(p) === dir)
				.map((p) => p.slice(p.lastIndexOf("/") + 1)),
		homedir: () => "/home/u",
	};
}

function countingDeps(
	files: Record<string, { dir?: boolean; size?: number }>,
): {
	deps: AttachmentPathDeps;
	calls: { fs: number };
} {
	const inner = fakeDeps(files);
	const calls = { fs: 0 };
	return {
		deps: {
			existsSync: (p) => {
				calls.fs++;
				return inner.existsSync(p);
			},
			statSync: (p) => {
				calls.fs++;
				return inner.statSync(p);
			},
			readdirSync: (p) => {
				calls.fs++;
				return inner.readdirSync(p);
			},
			homedir: inner.homedir,
		},
		calls,
	};
}

describe("detectAttachmentPaste", () => {
	test("prose stays text", () => {
		expect(detectAttachmentPaste("hello world", fakeDeps({}))).toEqual({
			kind: "text",
		});
	});

	test("path-lookalike that does not exist stays text", () => {
		expect(detectAttachmentPaste("/no/such/file.png", fakeDeps({}))).toEqual({
			kind: "text",
		});
	});

	test("extracts the existing path and keeps the rest as text", () => {
		const deps = fakeDeps({ "/a/x.png": { size: 5 } });
		const result = detectAttachmentPaste("/a/x.png /missing.pdf", deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual(["/a/x.png"]);
			expect(result.remainingText).toBe("/missing.pdf");
		}
	});

	test("extracts a quoted path from a mixed prompt", () => {
		const deps = fakeDeps({ "/a/shot.png": { size: 5 } });
		const result = detectAttachmentPaste(
			'"/a/shot.png" what does this say',
			deps,
		);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.fileName)).toEqual(["shot.png"]);
			expect(result.remainingText).toBe("what does this say");
		}
	});

	test("relative path stays text even if it exists", () => {
		const deps = { ...fakeDeps({}), existsSync: () => true };
		expect(detectAttachmentPaste("README.md", deps)).toEqual({ kind: "text" });
	});

	test("accepts existing files with allowed extensions", () => {
		const deps = fakeDeps({ "/a/x.png": { size: 5 }, "/b/y.pdf": { size: 7 } });
		const result = detectAttachmentPaste("/a/x.png /b/y.pdf", deps);
		expect(result).toEqual({
			kind: "attachments",
			accepted: [
				{ filePath: "/a/x.png", fileName: "x.png", sizeBytes: 5 },
				{ filePath: "/b/y.pdf", fileName: "y.pdf", sizeBytes: 7 },
			],
			rejected: [],
			remainingText: "",
		});
	});

	test("resolves a regular space to a U+202F filename (macOS screenshots)", () => {
		const real = "/Users/u/Desktop/Screenshot 10.45 PM.png";
		const deps = fakeDeps({
			[real]: { size: 9 },
			"/Users/u/Desktop": { dir: true },
		});
		// Pasted text uses an ordinary space before "PM".
		const result = detectAttachmentPaste(
			'"/Users/u/Desktop/Screenshot 10.45 PM.png" read this',
			deps,
		);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual([real]);
			expect(result.remainingText).toBe("read this");
		}
	});

	test("resolves a bare unquoted path with spaces (dragged screenshot)", () => {
		const real = "/Users/u/Desktop/Screenshot 10.45 PM.png";
		const deps = fakeDeps({
			[real]: { size: 9 },
			"/Users/u/Desktop": { dir: true },
		});
		const result = detectAttachmentPaste(real, deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual([real]);
			expect(result.remainingText).toBe("");
		}
	});

	test("resolves a bare U+202F name pasted with an ordinary space", () => {
		const real = "/Users/u/Desktop/Screenshot 10.45 PM.png";
		const deps = fakeDeps({
			[real]: { size: 9 },
			"/Users/u/Desktop": { dir: true },
		});
		// Bare path, ordinary space before PM, plus a trailing question.
		const result = detectAttachmentPaste(
			"/Users/u/Desktop/Screenshot 10.45 PM.png what is this",
			deps,
		);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual([real]);
			expect(result.remainingText).toBe("what is this");
		}
	});

	test("decodes a literal \\u{202f} escape to match a U+202F filename", () => {
		// A path copied as text carries the escape sequence, not the real glyph.
		const real = "/Users/u/Desktop/Screenshot 10.45 PM.png";
		const deps = fakeDeps({
			[real]: { size: 9 },
			"/Users/u/Desktop": { dir: true },
		});
		const result = detectAttachmentPaste(
			String.raw`"/Users/u/Desktop/Screenshot 10.45\u{202f}PM.png"`,
			deps,
		);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual([real]);
		}
	});

	test("expands tilde and file:// before checking existence", () => {
		const deps = fakeDeps({ "/home/u/pic.jpg": {}, "/tmp/a b.png": {} });
		const result = detectAttachmentPaste(
			"~/pic.jpg file:///tmp/a%20b.png",
			deps,
		);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.filePath)).toEqual([
				"/home/u/pic.jpg",
				"/tmp/a b.png",
			]);
		}
	});

	test("silently leaves directories in the text", () => {
		const deps = fakeDeps({ "/a/dir": { dir: true }, "/a/x.png": {} });
		const result = detectAttachmentPaste("/a/dir /a/x.png", deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.fileName)).toEqual(["x.png"]);
			expect(result.rejected).toEqual([]);
			expect(result.remainingText).toBe("/a/dir");
		}
	});

	test("a lone directory paste stays text", () => {
		const deps = fakeDeps({ "/a/dir": { dir: true } });
		expect(detectAttachmentPaste("/a/dir", deps)).toEqual({ kind: "text" });
	});

	test("disallowed extensions stay text; oversized files get a notice", () => {
		const deps = fakeDeps({
			"/a/x.exe": {},
			"/a/big.png": { size: 15 * 1024 * 1024 },
		});
		const result = detectAttachmentPaste("/a/x.exe /a/big.png", deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted).toEqual([]);
			expect(result.rejected.map((r) => r.reason)).toEqual([
				"file exceeds the 10 MB limit",
			]);
			expect(result.remainingText).toBe("/a/x.exe /a/big.png");
		}
	});

	test("multi-line paste stays text without touching the filesystem", () => {
		const { deps, calls } = countingDeps({
			"/tmp": { dir: true },
			"/a/x.png": { size: 5 },
		});
		const text = "Skipped /tmp earlier\nsee /a/x.png for details\nmore prose";
		expect(detectAttachmentPaste(text, deps)).toEqual({ kind: "text" });
		expect(calls.fs).toBe(0);
	});

	test("extension-less paths are never probed", () => {
		const { deps, calls } = countingDeps({
			"/tmp": { dir: true },
			"/dev/null": {},
		});
		expect(detectAttachmentPaste("check /tmp and /dev/null", deps)).toEqual({
			kind: "text",
		});
		expect(calls.fs).toBe(0);
	});

	test("a single line with many tokens stays text", () => {
		const { deps, calls } = countingDeps({ "/a/x.py": { size: 5 } });
		const words = Array.from({ length: 40 }, (_, k) => `word${k}`);
		const text = `${words.slice(0, 20).join(" ")} /a/x.py ${words.slice(20).join(" ")}`;
		expect(detectAttachmentPaste(text, deps)).toEqual({ kind: "text" });
		expect(calls.fs).toBe(0);
	});

	test("a dropped path with a trailing newline still attaches", () => {
		const deps = fakeDeps({ "/a/x.png": { size: 5 } });
		const result = detectAttachmentPaste("/a/x.png\r\n", deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted.map((f) => f.fileName)).toEqual(["x.png"]);
		}
	});

	test("extension check is case-insensitive", () => {
		const deps = fakeDeps({ "/a/PHOTO.PNG": { size: 3 } });
		const result = detectAttachmentPaste("/a/PHOTO.PNG", deps);
		expect(result.kind).toBe("attachments");
		if (result.kind === "attachments") {
			expect(result.accepted[0]?.fileName).toBe("PHOTO.PNG");
		}
	});
});
