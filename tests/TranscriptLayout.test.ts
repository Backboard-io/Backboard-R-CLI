import { describe, expect, it } from "bun:test";
import type { RenderTranscriptItem } from "../src/state/AppState.ts";
import {
	compactLiveTranscriptItems,
	splitResponsiveTranscript,
} from "../src/ui/components/TranscriptLayout.ts";

describe("splitResponsiveTranscript", () => {
	const items = Array.from({ length: 5 }, (_, index) => ({
		kind: "notice" as const,
		id: `n_${index}`,
		level: "info" as const,
		text: `notice ${index}`,
	})) satisfies RenderTranscriptItem[];

	it("keeps recent transcript items responsive", () => {
		const layout = splitResponsiveTranscript(items, 2);

		expect(layout.staticItems.map((item) => item.id)).toEqual([
			"n_0",
			"n_1",
			"n_2",
		]);
		expect(layout.responsiveItems.map((item) => item.id)).toEqual([
			"n_3",
			"n_4",
		]);
	});

	it("keeps short transcripts fully responsive", () => {
		const layout = splitResponsiveTranscript(items.slice(0, 2), 4);

		expect(layout.staticItems).toEqual([]);
		expect(layout.responsiveItems.map((item) => item.id)).toEqual([
			"n_0",
			"n_1",
		]);
	});

	it("can disable the responsive tail during streaming", () => {
		const layout = splitResponsiveTranscript(items, 0);

		expect(layout.staticItems.map((item) => item.id)).toEqual([
			"n_0",
			"n_1",
			"n_2",
			"n_3",
			"n_4",
		]);
		expect(layout.responsiveItems).toEqual([]);
	});

	it("keeps previously emitted static items static", () => {
		const layout = splitResponsiveTranscript(items, 4, 3);

		expect(layout.staticItems.map((item) => item.id)).toEqual([
			"n_0",
			"n_1",
			"n_2",
		]);
		expect(layout.responsiveItems.map((item) => item.id)).toEqual([
			"n_3",
			"n_4",
		]);
	});

	it("compacts large live transcript batches", () => {
		const compacted = compactLiveTranscriptItems(items, 2);

		expect(compacted.map((item) => item.id)).toEqual([
			"live-items-hidden",
			"n_3",
			"n_4",
		]);
		expect(compacted[0]).toMatchObject({
			kind: "notice",
			text: "3 earlier live items hidden while this turn is running.",
		});
	});

	it("keeps running live items visible while compacting", () => {
		const runningTool: RenderTranscriptItem = {
			kind: "tool",
			id: "tool_1",
			name: "Read",
			inputSummary: "file",
			status: "running",
		};
		const compacted = compactLiveTranscriptItems([runningTool, ...items], 2);

		expect(compacted.map((item) => item.id)).toEqual([
			"live-items-hidden",
			"tool_1",
			"n_3",
			"n_4",
		]);
	});
});
