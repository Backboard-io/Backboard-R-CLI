import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type BrowserEnv, loadBrowserEnv } from "../../config/env.ts";

export interface BrowserExecutableOptions {
	env?: BrowserEnv;
	pathDirs?: string[];
	appDirs?: string[];
	canExecute?: (path: string) => Promise<boolean>;
	platform?: NodeJS.Platform;
}

const PATH_NAMES = [
	"google-chrome",
	"google-chrome-stable",
	"chromium",
	"chromium-browser",
	"chrome.exe",
	"chromium.exe",
	"msedge",
	"microsoft-edge",
	"msedge.exe",
	"brave-browser",
	"brave.exe",
];
const MAC_APPS = [
	{ app: "Google Chrome.app", bin: "Google Chrome" },
	{ app: "Google Chrome Canary.app", bin: "Google Chrome Canary" },
	{ app: "Chromium.app", bin: "Chromium" },
	{ app: "Microsoft Edge.app", bin: "Microsoft Edge" },
	{ app: "Brave Browser.app", bin: "Brave Browser" },
];
const WINDOWS_APPS = [
	["Google", "Chrome", "Application", "chrome.exe"],
	["Google", "Chrome Beta", "Application", "chrome.exe"],
	["Google", "Chrome SxS", "Application", "chrome.exe"],
	["Chromium", "Application", "chrome.exe"],
	["Microsoft", "Edge", "Application", "msedge.exe"],
	["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
];

export async function findBrowserExecutable(
	options: BrowserExecutableOptions = {},
): Promise<string> {
	const env = options.env ?? loadBrowserEnv();
	const canExecute = options.canExecute ?? isExecutable;

	const explicit = [
		{ name: "BROWSER_PATH", value: env.browserPath },
		{ name: "CHROME_PATH", value: env.chromePath },
	];
	for (const item of explicit) {
		if (!item.value) continue;
		if (await canExecute(item.value)) return item.value;
		throw new Error(`${item.name} is set but is not executable: ${item.value}`);
	}

	const platform = options.platform ?? process.platform;
	if (platform === "darwin") {
		const executable = await firstExecutable(
			macAppPaths(options.appDirs ?? defaultMacAppDirs(env)),
			canExecute,
		);
		if (executable) return executable;
	}

	if (platform === "win32") {
		const executable = await firstExecutable(windowsAppPaths(env), canExecute);
		if (executable) return executable;
	}

	for (const dir of options.pathDirs ?? pathDirs(env)) {
		for (const name of PATH_NAMES) {
			const path = join(dir, name);
			if (await canExecute(path)) return path;
		}
	}

	throw new Error(
		"Could not find Chrome, Edge, or another Chromium browser. Install Chrome or set BROWSER_PATH to a browser executable.",
	);
}

async function isExecutable(path: string): Promise<boolean> {
	try {
		await access(path, 0x01);
		return true;
	} catch {
		return false;
	}
}

function defaultMacAppDirs(env: BrowserEnv): string[] {
	const dirs = ["/Applications"];
	if (env.home) dirs.push(join(env.home, "Applications"));
	return dirs;
}

function macAppPaths(dirs: string[]): string[] {
	return dirs.flatMap((dir) =>
		MAC_APPS.map((candidate) =>
			join(dir, candidate.app, "Contents", "MacOS", candidate.bin),
		),
	);
}

function windowsAppPaths(env: BrowserEnv): string[] {
	const roots = [
		env.programFiles,
		env.programFilesX86,
		env.localAppData,
	].filter((root): root is string => Boolean(root));
	return WINDOWS_APPS.flatMap((parts) =>
		roots.map((root) => join(root, ...parts)),
	);
}

function pathDirs(env: BrowserEnv): string[] {
	return (env.path ?? "")
		.split(delimiter)
		.map((item) => item.trim())
		.filter(Boolean);
}

async function firstExecutable(
	paths: string[],
	canExecute: (path: string) => Promise<boolean>,
): Promise<string | null> {
	for (const path of paths) {
		if (await canExecute(path)) return path;
	}
	return null;
}
