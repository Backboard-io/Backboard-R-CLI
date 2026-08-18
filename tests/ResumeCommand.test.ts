import { describe, expect, it } from "bun:test";
import {
	buildResumeCommand,
	quoteShellArg,
	withoutResumeFlag,
} from "../src/config/resumeCommand.ts";

describe("resume command", () => {
	it("preserves invocation flags and replaces a separated resume ID", () => {
		expect(
			buildResumeCommand(
				["--bypass", "--hi", "--a", "--resume", "old_id"],
				"thread_new",
				{ platform: "darwin" },
			),
		).toBe("backboard --bypass --hi --a --resume thread_new");
	});

	it("preserves cwd only when it was present in the original invocation", () => {
		expect(
			buildResumeCommand(
				["--cwd", "/tmp/old project", "--resume=old"],
				"thread_new",
				{ platform: "darwin" },
			),
		).toBe("backboard --cwd '/tmp/old project' --resume thread_new");
		expect(buildResumeCommand([], "thread_new", { platform: "darwin" })).toBe(
			"backboard --resume thread_new",
		);
	});

	it("does not discard the next flag when resume has no value", () => {
		expect(withoutResumeFlag(["--resume", "--lsp"])).toEqual(["--lsp"]);
	});

	it("quotes embedded apostrophes safely on POSIX shells", () => {
		expect(quoteShellArg("it's here", "linux")).toBe(`'it'"'"'s here'`);
	});

	it("quotes PowerShell arguments without expanding variables", () => {
		expect(quoteShellArg("C:\\work\\$archive", "win32")).toBe(
			"'C:\\work\\$archive'",
		);
		expect(quoteShellArg("it's here", "win32")).toBe("'it''s here'");
	});
});
