import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { findBrowserExecutable } from "../src/core/browser/BrowserExecutable.ts";

describe("findBrowserExecutable", () => {
	it("prefers explicit environment paths", async () => {
		const executable = "/custom/chrome";
		expect(
			await findBrowserExecutable({
				env: { browserPath: executable },
				canExecute: async (path) => path === executable,
				platform: "darwin",
				appDirs: [],
				pathDirs: [],
			}),
		).toBe(executable);
	});

	it("discovers macOS browser app bundles", async () => {
		const appDir = "/Applications";
		const executable = join(
			appDir,
			"Google Chrome.app",
			"Contents",
			"MacOS",
			"Google Chrome",
		);
		expect(
			await findBrowserExecutable({
				env: {},
				canExecute: async (path) => path === executable,
				platform: "darwin",
				appDirs: [appDir],
				pathDirs: [],
			}),
		).toBe(executable);
	});

	it("falls back to PATH discovery", async () => {
		const executable = join("/usr/bin", "chromium");
		expect(
			await findBrowserExecutable({
				env: {},
				canExecute: async (path) => path === executable,
				platform: "linux",
				pathDirs: ["/bin", "/usr/bin"],
			}),
		).toBe(executable);
	});

	it("discovers Windows Chrome installs", async () => {
		const root = "C:\\Program Files";
		const executable = join(
			root,
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		);

		expect(
			await findBrowserExecutable({
				env: { programFiles: root },
				canExecute: async (path) => path === executable,
				platform: "win32",
				pathDirs: [],
			}),
		).toBe(executable);
	});

	it("uses Edge when Chrome is not installed", async () => {
		const root = "C:\\Program Files";
		const executable = join(
			root,
			"Microsoft",
			"Edge",
			"Application",
			"msedge.exe",
		);

		expect(
			await findBrowserExecutable({
				env: { programFiles: root },
				canExecute: async (path) => path === executable,
				platform: "win32",
				pathDirs: [],
			}),
		).toBe(executable);
	});

	it("prefers Chrome over Edge", async () => {
		const root = "C:\\Program Files";
		const chrome = join(root, "Google", "Chrome", "Application", "chrome.exe");
		const edge = join(root, "Microsoft", "Edge", "Application", "msedge.exe");

		expect(
			await findBrowserExecutable({
				env: { programFiles: root },
				canExecute: async (path) => path === chrome || path === edge,
				platform: "win32",
				pathDirs: [],
			}),
		).toBe(chrome);
	});

	it("preserves browser priority across Windows install roots", async () => {
		const programFiles = "C:\\Program Files";
		const localAppData = "C:\\Users\\me\\AppData\\Local";
		const chrome = join(
			localAppData,
			"Google",
			"Chrome",
			"Application",
			"chrome.exe",
		);
		const edge = join(
			programFiles,
			"Microsoft",
			"Edge",
			"Application",
			"msedge.exe",
		);

		expect(
			await findBrowserExecutable({
				env: { programFiles, localAppData },
				canExecute: async (path) => path === chrome || path === edge,
				platform: "win32",
				pathDirs: [],
			}),
		).toBe(chrome);
	});

	it("tells the user to install Chrome when no browser is found", async () => {
		await expect(
			findBrowserExecutable({
				env: {},
				canExecute: async () => false,
				platform: "linux",
				pathDirs: [],
			}),
		).rejects.toThrow("Install Chrome");
	});
});
