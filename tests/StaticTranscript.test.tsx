import { describe, expect, it } from "bun:test";
import { Box, render, Text } from "ink";
import type React from "react";
import type { RenderTranscriptItem } from "../src/state/AppState.ts";
import {
	StaticTranscript,
	type StaticTranscriptBanner,
} from "../src/ui/components/StaticTranscript.tsx";
import {
	useStableStaticBanner,
	useStableTranscriptLayout,
} from "../src/ui/hooks/useStableTranscriptLayout.ts";
import { makeInkTty } from "./inkHarness.ts";

const firstItem: RenderTranscriptItem = {
	kind: "notice",
	id: "notice-1",
	level: "info",
	text: "first static item",
};
const staticItems = [firstItem];
const banner: StaticTranscriptBanner = {
	status: "idle",
	model: "test/model",
	cwd: "/tmp/project",
	usage: {},
};

describe("StaticTranscript", () => {
	it("prints a banner that appears after a generation reset", async () => {
		const tty = makeInkTty(80, 24);
		const instance = render(
			<StaticFrame items={[]} generation={2} banner={null} />,
			renderOptions(tty),
		);

		try {
			await instance.waitUntilRenderFlush();
			instance.rerender(
				<StaticFrame items={[]} generation={2} banner={banner} />,
			);
			await instance.waitUntilRenderFlush();

			expect(tty.written()).toContain("Backboard CLI is ready");
		} finally {
			instance.unmount();
		}
	});

	it("does not lose the next item after removing a banner", async () => {
		const tty = makeInkTty(80, 24);
		const instance = render(
			<StaticFrame items={[]} generation={1} banner={banner} />,
			renderOptions(tty),
		);

		try {
			await instance.waitUntilRenderFlush();
			instance.rerender(
				<StaticFrame items={[]} generation={1} banner={null} />,
			);
			await instance.waitUntilRenderFlush();
			instance.rerender(
				<StaticFrame items={staticItems} generation={1} banner={null} />,
			);
			await instance.waitUntilRenderFlush();

			expect(tty.written()).toContain(firstItem.text);
		} finally {
			instance.unmount();
		}
	});

	it("keeps dynamic updates behind Ink's frame throttle", async () => {
		const tty = makeInkTty(80, 12);
		let renderCount = 0;
		const instance = render(<TranscriptFrame tick={0} />, {
			...renderOptions(tty),
			maxFps: 5,
			onRender: () => {
				renderCount += 1;
			},
		});

		try {
			await instance.waitUntilRenderFlush();
			const initialRenderCount = renderCount;
			for (let tick = 1; tick <= 20; tick += 1) {
				instance.rerender(<TranscriptFrame tick={tick} />);
			}
			await Bun.sleep(50);

			expect(renderCount - initialRenderCount).toBeLessThanOrEqual(2);
		} finally {
			instance.unmount();
		}
	});
});

function TranscriptFrame({ tick }: { tick: number }): React.ReactElement {
	const layout = useStableTranscriptLayout(staticItems, 0, 1);
	return (
		<Box flexDirection="column">
			<StaticTranscript
				items={layout.staticItems}
				generation={1}
				banner={null}
			/>
			<Text>{`${tick}\n`.repeat(20)}</Text>
		</Box>
	);
}

function StaticFrame({
	items,
	generation,
	banner,
}: {
	items: RenderTranscriptItem[];
	generation: number;
	banner: StaticTranscriptBanner | null;
}): React.ReactElement {
	const stableBanner = useStableStaticBanner(banner, generation);
	return (
		<StaticTranscript
			items={items}
			generation={generation}
			banner={stableBanner}
		/>
	);
}

function renderOptions(tty: ReturnType<typeof makeInkTty>) {
	return {
		stdout: tty.stdout as unknown as NodeJS.WriteStream,
		stdin: tty.stdin,
		exitOnCtrlC: false,
		patchConsole: false,
	};
}
