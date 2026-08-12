import { describe, expect, it } from "bun:test";
import {
	filterItems,
	initialPickerPosition,
	movePickerSelection,
	pickerTabArrowsEnabled,
	resetPickerSelection,
} from "../src/ui/components/Picker.tsx";

describe("Picker tab arrows", () => {
	it("switches tabs with arrows when the search box is empty", () => {
		expect(pickerTabArrowsEnabled(true, "")).toBe(true);
		expect(pickerTabArrowsEnabled(false, "")).toBe(true);
	});

	it("leaves arrows to the search cursor while search has text", () => {
		expect(pickerTabArrowsEnabled(true, "glm")).toBe(false);
	});

	it("still switches tabs when search is disabled regardless of text", () => {
		expect(pickerTabArrowsEnabled(false, "glm")).toBe(true);
	});
});

describe("Picker search", () => {
	const items = [
		{ id: "docs", name: "docs", status: "loaded", value: "docs" },
		{ id: "notes", name: "notes", status: "unloaded", value: "notes" },
		{ id: "review", name: "review-loaded-prs", value: "review" },
	];

	it("matches status exactly so loaded does not match unloaded rows", () => {
		expect(filterItems(items, "loaded").map((item) => item.id)).toEqual([
			"docs",
			"review",
		]);
		expect(filterItems(items, "unloaded").map((item) => item.id)).toEqual([
			"notes",
		]);
	});

	it("still matches the other columns by substring", () => {
		expect(filterItems(items, "note").map((item) => item.id)).toEqual([
			"notes",
		]);
		expect(filterItems(items, "").map((item) => item.id)).toEqual([
			"docs",
			"notes",
			"review",
		]);
	});
});

describe("Picker initial position", () => {
	const tabs = [
		{ id: "a", label: "A", items: [{ id: "a:one", name: "one", value: 1 }] },
		{
			id: "b",
			label: "B",
			items: [
				{ id: "b:one", name: "one", value: 2 },
				{ id: "b:two", name: "two", value: 3 },
			],
		},
	];

	it("finds the initial item across tabs", () => {
		expect(initialPickerPosition(tabs, "b:two")).toEqual({
			tabIndex: 1,
			itemIndex: 1,
		});
	});

	it("falls back to the start when the id is missing or absent", () => {
		expect(initialPickerPosition(tabs, undefined)).toEqual({
			tabIndex: 0,
			itemIndex: 0,
		});
		expect(initialPickerPosition(tabs, "gone")).toEqual({
			tabIndex: 0,
			itemIndex: 0,
		});
	});
});

describe("Picker pagination", () => {
	it("moves through oversized tabs with repeated down arrows", () => {
		let selection = resetPickerSelection();
		for (let i = 0; i < 13; i++) {
			selection = movePickerSelection(selection, 25, "down");
		}

		expect(selection).toEqual({ itemIndex: 13, windowStart: 2 });
	});

	it("pages through oversized MCP catalog tabs", () => {
		let selection = resetPickerSelection();

		selection = movePickerSelection(selection, 25, "pageDown");
		expect(selection).toEqual({ itemIndex: 12, windowStart: 12 });

		selection = movePickerSelection(selection, 25, "pageDown");
		expect(selection).toEqual({ itemIndex: 24, windowStart: 13 });

		selection = movePickerSelection(selection, 25, "pageUp");
		expect(selection).toEqual({ itemIndex: 12, windowStart: 1 });
	});

	it("wraps while keeping the selected item visible", () => {
		expect(movePickerSelection(resetPickerSelection(), 25, "up")).toEqual({
			itemIndex: 24,
			windowStart: 13,
		});
	});
});
