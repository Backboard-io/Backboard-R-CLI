import { describe, expect, it } from "bun:test";
import { ApplyPatchTool } from "../src/tools/ApplyPatchTool.tsx";
import { EditTool } from "../src/tools/EditTool.tsx";
import { WriteTool } from "../src/tools/WriteTool.tsx";

const acceptEdits = {
	mode: "acceptEdits" as const,
	cwd: "/project",
	interactive: true,
};
const manual = {
	mode: "manual" as const,
	cwd: "/project",
	interactive: true,
};
const auto = { mode: "auto" as const, cwd: "/project", interactive: true };

describe("WriteTool permissions", () => {
	const tool = new WriteTool();

	it("allows cwd writes in acceptEdits", () => {
		expect(
			tool.checkPermissions(
				{ file_path: "src/a.ts", content: "x" },
				acceptEdits,
			)?.behavior,
		).toBe("allow");
	});

	it("has no opinion outside cwd", () => {
		expect(
			tool.checkPermissions(
				{ file_path: "../elsewhere/a.ts", content: "x" },
				acceptEdits,
			),
		).toBeUndefined();
	});

	it("has no opinion in manual mode", () => {
		expect(
			tool.checkPermissions({ file_path: "src/a.ts", content: "x" }, manual),
		).toBeUndefined();
	});

	it("exposes the file path as permission content", () => {
		expect(
			tool.permissionContent({ file_path: "src/a.ts", content: "x" }),
		).toBe("src/a.ts");
	});

	it("allows cwd writes in auto", () => {
		expect(
			tool.checkPermissions({ file_path: "src/a.ts", content: "x" }, auto)
				?.behavior,
		).toBe("allow");
	});

	it("has no opinion outside cwd in auto", () => {
		expect(
			tool.checkPermissions(
				{ file_path: "../elsewhere/a.ts", content: "x" },
				auto,
			),
		).toBeUndefined();
	});
});

describe("EditTool permissions", () => {
	const tool = new EditTool();

	it("allows cwd edits in acceptEdits", () => {
		expect(
			tool.checkPermissions(
				tool.parseInput({ file_path: "src/a.ts", old_str: "a", new_str: "b" }),
				acceptEdits,
			)?.behavior,
		).toBe("allow");
	});

	it("allows cwd edits in auto", () => {
		expect(
			tool.checkPermissions(
				tool.parseInput({ file_path: "src/a.ts", old_str: "a", new_str: "b" }),
				auto,
			)?.behavior,
		).toBe("allow");
	});
});

describe("ApplyPatchTool permissions", () => {
	const tool = new ApplyPatchTool();
	const patchFor = (path: string) =>
		`*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`;

	it("allows patches that only touch cwd files in acceptEdits", () => {
		expect(
			tool.checkPermissions({ patch: patchFor("src/a.ts") }, acceptEdits)
				?.behavior,
		).toBe("allow");
	});

	it("has no opinion when a patch escapes cwd", () => {
		expect(
			tool.checkPermissions({ patch: patchFor("../outside.ts") }, acceptEdits),
		).toBeUndefined();
	});

	it("has no opinion in manual mode", () => {
		expect(
			tool.checkPermissions({ patch: patchFor("src/a.ts") }, manual),
		).toBeUndefined();
	});

	it("sees escaping paths in a patch that mixes line endings", () => {
		const mixed =
			"*** Begin Patch\n" +
			"*** Add File: notes.txt\n" +
			"+hello\n" +
			"*** Add File: ../../../../tmp/escaped.txt\r\n" +
			"+pwned\r\n" +
			"*** End Patch";

		expect(
			tool.checkPermissions({ patch: mixed }, acceptEdits),
		).toBeUndefined();
	});

	it("sees a CRLF rename destination that escapes cwd", () => {
		const renamed =
			"*** Begin Patch\r\n" +
			"*** Update File: src/a.ts\r\n" +
			"*** Move to: ../../outside.ts\r\n" +
			"@@\r\n" +
			"-a\r\n" +
			"+b\r\n" +
			"*** End Patch";

		expect(
			tool.checkPermissions({ patch: renamed }, acceptEdits),
		).toBeUndefined();
	});

	it("denies a patch that does not parse, so no grant can be persisted", () => {
		expect(
			tool.checkPermissions({ patch: "not a patch" }, acceptEdits)?.behavior,
		).toBe("deny");
		expect(
			tool.checkPermissions({ patch: "not a patch" }, manual)?.behavior,
		).toBe("deny");
	});

	it("exposes the patched paths as permission content", () => {
		expect(tool.permissionContent({ patch: patchFor("src/a.ts") })).toBe(
			"src/a.ts",
		);
	});

	it("exposes every path a multi-file patch touches", () => {
		const twoFiles =
			"*** Begin Patch\n" +
			"*** Update File: src/a.ts\n@@\n-a\n+b\n" +
			"*** Update File: src/b.ts\n@@\n-c\n+d\n" +
			"*** End Patch";
		expect(tool.permissionContent({ patch: twoFiles })).toBe(
			"src/a.ts src/b.ts",
		);
	});

	it("has no permission content when the patch does not parse", () => {
		expect(tool.permissionContent({ patch: "not a patch" })).toBeUndefined();
	});

	it("keeps a space inside a path distinct from a path separator", () => {
		const onePath =
			"*** Begin Patch\n*** Add File: src/file ../secret\n+x\n*** End Patch";
		const twoPaths =
			"*** Begin Patch\n" +
			"*** Add File: src/file\n+x\n" +
			"*** Add File: ../secret\n+pwned\n" +
			"*** End Patch";

		const single = tool.permissionContent({ patch: onePath });
		const pair = tool.permissionContent({ patch: twoPaths });
		expect(single).toBe("src/file\\ ../secret");
		expect(pair).toBe("src/file ../secret");
		expect(single).not.toBe(pair);
	});

	it("escapes a backslash so it cannot forge a separator", () => {
		const patch = "*** Begin Patch\n*** Add File: src/a\\ b\n+x\n*** End Patch";
		expect(tool.permissionContent({ patch })).toBe("src/a\\\\\\ b");
	});

	it("declares its permission content as paths", () => {
		expect(tool.permissionContentIsPaths()).toBe(true);
	});

	it("allows patches that only touch cwd files in auto", () => {
		expect(
			tool.checkPermissions({ patch: patchFor("src/a.ts") }, auto)?.behavior,
		).toBe("allow");
	});

	it("has no opinion when a patch escapes cwd in auto", () => {
		expect(
			tool.checkPermissions({ patch: patchFor("../outside.ts") }, auto),
		).toBeUndefined();
	});
});

describe("file tools declare path-shaped permission content", () => {
	it("keeps Write and Edit grants exact, extension or not", () => {
		expect(new WriteTool().permissionContentIsPaths()).toBe(true);
		expect(new EditTool().permissionContentIsPaths()).toBe(true);
	});
});
