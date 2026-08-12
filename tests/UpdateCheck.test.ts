import { describe, expect, it } from "bun:test";
import {
	fetchStartupUpdate,
	NO_UPDATE_CHECK_ENV,
} from "../src/core/update/startupNotice.ts";
import {
	checkForCliUpdate,
	cliInstallCommand,
	compareSemver,
	isNewerVersion,
} from "../src/core/update/updateCheck.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("compareSemver", () => {
	it("orders versions numerically, ignoring a v prefix and pre-release", () => {
		expect(compareSemver("3.0.1", "3.0.0")).toBeGreaterThan(0);
		expect(compareSemver("v3.0.0", "3.0.1")).toBeLessThan(0);
		expect(compareSemver("3.0.0", "3.0.0")).toBe(0);
		expect(compareSemver("3.10.0", "3.9.0")).toBeGreaterThan(0);
		expect(compareSemver("3.0.1-beta", "3.0.1")).toBe(0);
	});

	it("reports newer versions", () => {
		expect(isNewerVersion("3.0.1", "3.0.0")).toBe(true);
		expect(isNewerVersion("3.0.0", "3.0.0")).toBe(false);
		expect(isNewerVersion("2.9.9", "3.0.0")).toBe(false);
	});
});

describe("cliInstallCommand", () => {
	it("builds the install one-liner from the API url without trailing slash", () => {
		expect(cliInstallCommand("https://app.backboard.io/api/")).toBe(
			"curl -fsSL https://app.backboard.io/api/cli | sh",
		);
	});
});

describe("checkForCliUpdate", () => {
	it("reports an available update when the backend is newer", async () => {
		const result = await checkForCliUpdate({
			apiUrl: "https://app.backboard.io/api",
			currentVersion: "3.0.0",
			fetchImpl: async () => jsonResponse({ version: "3.0.1" }),
		});
		expect(result.status).toBe("update-available");
		expect(result.latestVersion).toBe("3.0.1");
		expect(result.command).toBe(
			"curl -fsSL https://app.backboard.io/api/cli | sh",
		);
	});

	it("reports up to date when versions match", async () => {
		const result = await checkForCliUpdate({
			apiUrl: "http://127.0.0.1:8000",
			currentVersion: "3.0.1",
			fetchImpl: async () => jsonResponse({ version: "3.0.1" }),
		});
		expect(result.status).toBe("up-to-date");
	});

	it("returns an error result on a non-200 response", async () => {
		const result = await checkForCliUpdate({
			apiUrl: "http://127.0.0.1:8000",
			currentVersion: "3.0.1",
			fetchImpl: async () => new Response("nope", { status: 503 }),
		});
		expect(result.status).toBe("error");
		expect(result.error).toContain("503");
	});

	it("returns an error result when fetch throws", async () => {
		const result = await checkForCliUpdate({
			apiUrl: "http://127.0.0.1:8000",
			currentVersion: "3.0.1",
			fetchImpl: async () => {
				throw new Error("network down");
			},
		});
		expect(result.status).toBe("error");
		expect(result.error).toContain("network down");
	});
});

describe("fetchStartupUpdate (session-card row)", () => {
	const params = (
		fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
	) => ({
		apiUrl: "https://api.example.com",
		currentVersion: "3.0.1",
		fetchImpl,
	});

	it("returns both version numbers when a newer version is published", async () => {
		const info = await fetchStartupUpdate(
			params(async () => jsonResponse({ version: "3.1.0" })),
			{},
		);
		expect(info).toEqual({ current: "3.0.1", latest: "3.1.0" });
	});

	it("returns null when up to date", async () => {
		const info = await fetchStartupUpdate(
			params(async () => jsonResponse({ version: "3.0.1" })),
			{},
		);
		expect(info).toBeNull();
	});

	it("returns null when the check fails", async () => {
		const info = await fetchStartupUpdate(
			params(async () => {
				throw new Error("network down");
			}),
			{},
		);
		expect(info).toBeNull();
	});

	it("is disabled by the opt-out env var", async () => {
		let fetched = false;
		const info = await fetchStartupUpdate(
			params(async () => {
				fetched = true;
				return jsonResponse({ version: "9.9.9" });
			}),
			{ [NO_UPDATE_CHECK_ENV]: "1" },
		);
		expect(fetched).toBe(false);
		expect(info).toBeNull();
	});
});
