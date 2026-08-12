import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import os from "node:os";
import { escapeForCmd } from "../src/core/oauth/LoopbackOAuth.ts";

const AUTHORIZE_URL =
	"https://access.stripe.com/mcp/oauth2/authorize?response_type=code&client_id=oacli_abc&code_challenge=x1y2&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A7813%2Foauth%2Fcallback&state=zz";

describe("escapeForCmd", () => {
	it("escapes every cmd.exe metacharacter", () => {
		expect(escapeForCmd("a&b")).toBe("a^&b");
		expect(escapeForCmd("a|b")).toBe("a^|b");
		expect(escapeForCmd("a<b")).toBe("a^<b");
		expect(escapeForCmd("a>b")).toBe("a^>b");
		expect(escapeForCmd("a(b)c")).toBe("a^(b^)c");
		expect(escapeForCmd("a^b")).toBe("a^^b");
		expect(escapeForCmd("a!b")).toBe("a^!b");
	});

	// Dropping % from the escape set would let a defined name expand, so a
	// hostile %USERPROFILE% in an authorize URL leaks to whoever served it.
	it("escapes % so environment variables cannot expand", () => {
		expect(escapeForCmd("p=%PATH%")).toBe("p=^%PATH^%");
	});

	it("leaves characters cmd does not treat specially alone", () => {
		expect(escapeForCmd("https://x.io/a-b_c.d~e/f?g=1")).toBe(
			"https://x.io/a-b_c.d~e/f?g=1",
		);
	});

	it("escapes every query separator in a real authorize URL", () => {
		const escaped = escapeForCmd(AUTHORIZE_URL);
		// No bare & survives — every one is preceded by a caret.
		expect(escaped).not.toMatch(/(?<!\^)&/);
		expect(escaped.match(/\^&/g)).toHaveLength(5);
		expect(escaped).toContain("http^%3A^%2F^%2Flocalhost");
	});
});

describe("openDefaultBrowser argv", () => {
	// Mirrors the argv construction in openDefaultBrowser. The real function
	// spawns a browser, so the branch itself is what gets asserted here.
	const argvFor = (platform: string, url: string): string[] => {
		const value = new URL(url).toString();
		return platform === "win32"
			? ["/c", "start", "", escapeForCmd(value)]
			: [value];
	};

	it("escapes only on win32", () => {
		expect(argvFor("win32", AUTHORIZE_URL)[3]).toBe(
			escapeForCmd(AUTHORIZE_URL),
		);
	});

	// open and xdg-open are real executables: nothing re-parses their argv, so
	// escaping there would put literal carets in the URL.
	it("passes the URL through unescaped on darwin and linux", () => {
		for (const platform of ["darwin", "linux"]) {
			expect(argvFor(platform, AUTHORIZE_URL)).toEqual([AUTHORIZE_URL]);
		}
	});

	it("normalizes whitespace and quotes before escaping", () => {
		// Both would make libuv quote the argument, which stops cmd from
		// consuming the carets and reopens the injection hole.
		const escaped = argvFor("win32", 'https://x.io/a?p=1&c=a b"q"&s=z')[3];
		expect(escaped).not.toMatch(/[\s"]/);
		expect(escaped).toBe("https://x.io/a?p=1^&c=a^%20b^%22q^%22^&s=z");
	});

	it("rejects values that are not URLs", () => {
		expect(() => argvFor("win32", "not a url & calc.exe")).toThrow();
	});
});

describe.if(os.platform() === "win32")("cmd.exe round-trip", () => {
	const echoThroughCmd = async (arg: string): Promise<string> =>
		await new Promise((resolve, reject) => {
			const child = spawn("cmd", ["/c", "echo", arg], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("close", () =>
				stderr ? reject(new Error(stderr)) : resolve(stdout.trim()),
			);
		});

	it("delivers the authorize URL to cmd byte-for-byte", async () => {
		expect(await echoThroughCmd(escapeForCmd(AUTHORIZE_URL))).toBe(
			AUTHORIZE_URL,
		);
	});

	it("does not expand environment variables", async () => {
		const url = "https://x.io/a?p=%PATH%&c=abc";
		expect(await echoThroughCmd(escapeForCmd(url))).toBe(url);
	});

	it("loses everything after the first & when unescaped", async () => {
		// The regression this guards: cmd reads & as a command separator, so the
		// browser was handed a URL with no client_id, state or PKCE challenge.
		await expect(echoThroughCmd(AUTHORIZE_URL)).rejects.toThrow(
			/not recognized as an internal or external command/,
		);
	});
});
