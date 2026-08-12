import { describe, expect, it } from "bun:test";
import {
	isKnownPermissionMode,
	nextPermissionMode,
	PERMISSION_MODES,
	parsePermissionMode,
	permissionModeLabel,
} from "../src/core/permissions/PermissionMode.ts";

describe("PermissionMode", () => {
	it("declares all four modes", () => {
		expect(PERMISSION_MODES).toEqual([
			"manual",
			"acceptEdits",
			"auto",
			"bypass",
		]);
	});

	it("parses valid modes and defaults to manual", () => {
		expect(parsePermissionMode("bypass")).toBe("bypass");
		expect(parsePermissionMode("acceptEdits")).toBe("acceptEdits");
		expect(parsePermissionMode("nonsense")).toBe("manual");
		expect(parsePermissionMode(undefined)).toBe("manual");
	});

	it("recognizes known modes (for flag validation)", () => {
		expect(isKnownPermissionMode("bypass")).toBe(true);
		expect(isKnownPermissionMode("acceptedits")).toBe(false);
		expect(isKnownPermissionMode(undefined)).toBe(false);
	});

	it("cycles manual → acceptEdits → auto → manual, excluding bypass", () => {
		expect(nextPermissionMode("manual")).toBe("acceptEdits");
		expect(nextPermissionMode("acceptEdits")).toBe("auto");
		expect(nextPermissionMode("auto")).toBe("manual");
		// bypass is flag-only; cycling out of it exits to the top.
		expect(nextPermissionMode("bypass")).toBe("manual");
	});

	it("labels modes for the status bar", () => {
		expect(permissionModeLabel("manual")).toBe("Manual");
		expect(permissionModeLabel("acceptEdits")).toBe("Accept Edits");
		expect(permissionModeLabel("auto")).toBe("Auto");
		expect(permissionModeLabel("bypass")).toBe("Bypass");
	});
});
