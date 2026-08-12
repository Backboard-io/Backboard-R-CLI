import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "../src/core/tools/ToolRegistry.ts";
import { TestTool } from "./helpers.ts";

describe("ToolRegistry", () => {
	it("registers and looks up tools", () => {
		const registry = new ToolRegistry([
			new TestTool({ name: "A" }),
			new TestTool({ name: "B" }),
		]);
		expect(registry.has("A")).toBe(true);
		expect(registry.get("B")?.name).toBe("B");
		expect(registry.list().length).toBe(2);
	});

	it("rejects duplicate names", () => {
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);
		expect(() => registry.register(new TestTool({ name: "A" }))).toThrow();
	});

	it("unregisters tools by name", () => {
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);

		expect(registry.unregister("A")).toBe(true);
		expect(registry.has("A")).toBe(false);
		expect(registry.unregister("A")).toBe(false);
	});

	it("produces OpenAI tool schemas", () => {
		const registry = new ToolRegistry([new TestTool({ name: "A" })]);
		const schemas = registry.toJSONSchemas();
		expect(schemas[0]?.type).toBe("function");
		expect(schemas[0]?.function.name).toBe("A");
		expect(schemas[0]?.function.parameters).toHaveProperty("type", "object");
	});

	it("filters by subset, empty means all", () => {
		const registry = new ToolRegistry([
			new TestTool({ name: "A" }),
			new TestTool({ name: "B" }),
		]);
		expect(registry.filtered([]).length).toBe(2);
		expect(registry.filtered(["A"]).map((t) => t.name)).toEqual(["A"]);
	});

	it("excludes tools from all and subset filters", () => {
		const registry = new ToolRegistry([
			new TestTool({ name: "A" }),
			new TestTool({ name: "B" }),
		]);
		expect(registry.filtered([], ["B"]).map((t) => t.name)).toEqual(["A"]);
		expect(registry.filtered(["A", "B"], ["A"]).map((t) => t.name)).toEqual([
			"B",
		]);
	});
});
