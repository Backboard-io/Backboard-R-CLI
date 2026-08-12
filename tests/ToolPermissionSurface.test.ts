import { describe, expect, it } from "bun:test";
import { TestTool } from "./helpers.ts";

describe("Tool permission surface defaults", () => {
	it("checkPermissions defaults to undefined (no opinion)", () => {
		const tool = new TestTool({ name: "sample" });
		expect(
			tool.checkPermissions(
				{ value: "x" },
				{ mode: "manual", cwd: "/tmp", interactive: true },
			),
		).toBeUndefined();
	});

	it("permissionContent defaults to undefined", () => {
		const tool = new TestTool({ name: "sample" });
		expect(tool.permissionContent({ value: "x" })).toBeUndefined();
	});

	it("permissionContentIsPaths defaults to false, so commands generalize", () => {
		const tool = new TestTool({ name: "sample" });
		expect(tool.permissionContentIsPaths({ value: "x" })).toBe(false);
	});
});
