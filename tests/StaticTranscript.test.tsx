import { describe, expect, it } from "bun:test";
import { Box, render, Text } from "ink";
import type React from "react";
import type { RenderTranscriptItem } from "../src/state/AppState.ts";
import {
	StaticTranscript,
	shouldReuseStaticTranscript,
} from "../src/ui/components/StaticTranscript.tsx";
import { makeInkTty } from "./inkHarness.ts";

const firstItem: RenderTranscriptItem = {
	kind: "notice",
	id: "notice-1",
	level: "info",
	text: "first static item",
};
const secondItem: RenderTranscriptItem = {
	kind: "notice",
	id: "notice-2",
	level: "info",
	text: "second static item",
};

describe("StaticTranscript", () => {
	it("reuses the append-only subtree until its items or generation change", () => {
		const previous = {
			items: [firstItem],
			generation: 1,
			banner: null,
		};

		expect(
			shouldReuseStaticTranscript(previous, {
				...previous,
				items: [...previous.items],
			}),
		).toBe(true);
		expect(
			shouldReuseStaticTranscript(previous, {
				...previous,
				items: [firstItem, secondItem],
			}),
		).toBe(false);
		expect(
			shouldReuseStaticTranscript(previous, {
				...previous,
				generation: 2,
			}),
		).toBe(false);
	});

	it("keeps dynamic updates behind Ink's frame throttle", async () => {
		const tty = makeInkTty(80, 12);
		let renderCount = 0;
		const frame = (tick: number): React.ReactElement => (
			<Box flexDirection="column">
				<StaticTranscript items={[firstItem]} generation={1} banner={null} />
				<Text>{`${tick}\n`.repeat(20)}</Text>
			</Box>
		);
		const instance = render(frame(0), {
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin,
			exitOnCtrlC: false,
			maxFps: 5,
			patchConsole: false,
			onRender: () => {
				renderCount += 1;
			},
		});

		try {
			await instance.waitUntilRenderFlush();
			const initialRenderCount = renderCount;
			for (let tick = 1; tick <= 20; tick += 1) {
				instance.rerender(frame(tick));
			}
			await Bun.sleep(50);

			expect(renderCount - initialRenderCount).toBeLessThanOrEqual(2);
		} finally {
			instance.unmount();
		}
	});
});
