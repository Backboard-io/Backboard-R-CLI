import { describe, expect, it } from "bun:test";
import { CliUserError } from "../src/config/CliUserError.ts";
import { parseOutputFormat } from "../src/config/defaults.ts";
import {
	canPromptForPermissions,
	isHeadlessInvocation,
	parseRequestedResume,
} from "../src/config/resumePreflight.ts";

describe("resume preflight", () => {
	it("rejects a missing resume ID before startup", () => {
		expect(() => parseRequestedResume("")).toThrow(CliUserError);
		expect(() => parseRequestedResume("  ")).toThrow(
			"--resume requires a session ID.",
		);
		expect(parseRequestedResume(undefined)).toBeUndefined();
		expect(parseRequestedResume(" thread_123 ")).toBe("thread_123");
	});

	it("uses the canonical output format for headless detection", () => {
		expect(
			isHeadlessInvocation({}, parseOutputFormat("JSON"), {
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(true);
		expect(
			isHeadlessInvocation({}, parseOutputFormat("default"), {
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(false);
		expect(
			isHeadlessInvocation({ print: "hello" }, "default", {
				stdinIsTTY: true,
				stdoutIsTTY: true,
			}),
		).toBe(true);
	});

	it("uses input capability rather than stdout TTY for permission prompts", () => {
		expect(
			canPromptForPermissions({}, "default", {
				stdinIsTTY: true,
			}),
		).toBe(true);
		expect(
			canPromptForPermissions({}, "default", {
				stdinIsTTY: false,
			}),
		).toBe(false);
		expect(
			canPromptForPermissions({ print: "hello" }, "default", {
				stdinIsTTY: true,
			}),
		).toBe(false);
		expect(
			canPromptForPermissions({}, "json", {
				stdinIsTTY: true,
			}),
		).toBe(false);
	});
});
