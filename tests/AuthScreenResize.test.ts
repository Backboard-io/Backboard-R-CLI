import { describe, expect, it } from "bun:test";
import { render } from "ink";
import React from "react";
import { AuthScreen } from "../src/ui/AuthScreen.tsx";
import {
	CLEAR_VISIBLE_SCREEN,
	RESIZE_SETTLE_DELAY_MS,
} from "../src/ui/hooks/ResizeStabilizer.constants.ts";
import { type InkTty, makeInkTty } from "./inkHarness.ts";

function renderAuthScreen(tty: InkTty) {
	return render(
		React.createElement(AuthScreen, {
			onLogin: () => new Promise<string>(() => {}),
		}),
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("AuthScreen resize handling", () => {
	it("clears screen and scrollback when the terminal is resized", async () => {
		const tty = makeInkTty(80, 45);
		const instance = renderAuthScreen(tty);
		await sleep(20);
		expect(tty.written()).not.toContain(CLEAR_VISIBLE_SCREEN);
		tty.stdout.columns = 60;
		tty.stdout.emit("resize");
		await sleep(20);
		instance.unmount();
		expect(tty.written()).toContain(CLEAR_VISIBLE_SCREEN);
	});

	it("goes blank during the resize and repaints once it settles", async () => {
		const tty = makeInkTty(80, 45);
		const instance = renderAuthScreen(tty);
		await sleep(20);
		const beforeResize = tty.written().length;
		tty.stdout.columns = 60;
		tty.stdout.emit("resize");
		await sleep(RESIZE_SETTLE_DELAY_MS / 2);
		// Transient repaints right after the clear match App.tsx's resize
		// behavior; what matters is that the screen settles blank until the
		// stabilizer's delay elapses.
		const duringResize = tty.written().slice(beforeResize);
		const lastFrame = duringResize.slice(
			duringResize.lastIndexOf("\x1b[?2026h"),
		);
		expect(lastFrame).not.toContain("Login with Backboard");
		await sleep(RESIZE_SETTLE_DELAY_MS * 2);
		const afterSettle = tty.written().slice(beforeResize);
		instance.unmount();
		expect(afterSettle).toContain("Login with Backboard");
	});
});
