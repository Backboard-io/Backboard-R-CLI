#!/usr/bin/env bun
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSessionManager } from "../src/core/browser/BrowserSessionManager.ts";

const screenshotDir = await mkdtemp(join(tmpdir(), "q-browser-smoke-"));
const manager = new BrowserSessionManager({
	env: {
		...process.env,
		Q_BROWSER_CDP_URL: undefined,
		Q_BROWSER_WS_URL: undefined,
	},
});

try {
	const signal = new AbortController().signal;
	const platform = await manager.getPlatform(signal);

	await platform.navigate(
		"data:text/html,<title>q browser smoke</title><button id='ok'>OK</button>",
		signal,
	);
	await delay(500);
	const shot = await platform.screenshot(
		join(screenshotDir, "screen.png"),
		signal,
	);
	const snapshot = await platform.accessibilitySnapshot(signal);
	const okButton = snapshot.elements.find((item) => item.name === "OK");
	if (!okButton?.bounds) {
		throw new Error("Could not find smoke-test button in browser snapshot.");
	}
	await platform.execute(
		{
			kind: "click",
			point: {
				x: okButton.bounds.x + okButton.bounds.width / 2,
				y: okButton.bounds.y + okButton.bounds.height / 2,
			},
			button: "left",
		},
		signal,
	);

	process.stdout.write(
		`Browser harness smoke passed (${shot.screenSize.width}x${shot.screenSize.height}, ${snapshot.elements.length} elements).\n`,
	);
} finally {
	await manager.dispose();
	await rm(screenshotDir, { recursive: true, force: true });
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
