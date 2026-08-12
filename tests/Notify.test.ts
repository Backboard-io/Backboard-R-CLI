import { describe, expect, it } from "bun:test";
import { playCompletionNotification } from "../src/ui/notify.ts";
import { shellPathLabel } from "../src/ui/utils/pathLabels.ts";

describe("Banner", () => {
	it("shortens home paths in the shell path", () => {
		expect(shellPathLabel("/Users/ryu", "/Users/ryu")).toBe("~");
		expect(
			shellPathLabel("/Users/ryu/Documents/GitHub/Espri-API", "/Users/ryu"),
		).toBe("~/Documents/GitHub/Espri-API");
		expect(shellPathLabel("/tmp/project", "/Users/ryu")).toBe("/tmp/project");
	});

	it("does not shorten paths with a matching prefix outside home", () => {
		expect(
			shellPathLabel("/Users/ryushentan-other/project", "/Users/ryushentan"),
		).toBe("/Users/ryushentan-other/project");
	});
});

describe("completion notifications", () => {
	it("plays a macOS notification sound", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		playCompletionNotification(() => {}, {
			platform: "darwin",
			spawnSound: (command, args) => calls.push({ command, args }),
		});
		expect(calls).toEqual([
			{
				command: "afplay",
				args: ["/System/Library/Sounds/Glass.aiff"],
			},
		]);
	});

	it("falls back to a terminal bell off macOS", () => {
		const chunks: string[] = [];
		playCompletionNotification((value) => chunks.push(value), {
			platform: "linux",
		});
		expect(chunks).toEqual(["\u0007"]);
	});
});
