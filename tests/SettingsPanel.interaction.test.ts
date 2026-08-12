import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import {
	SettingsPanel,
	type SettingsState,
	type SettingsToggleId,
} from "../src/ui/components/SettingsPanel.tsx";

const BASE: SettingsState = {
	memory: "auto",
	verbose: false,
	notify: false,
	lsp: false,
	lspPending: false,
	browser: false,
	computerUse: false,
	discover: false,
};

const ESC_CHAR = String.fromCharCode(27);
const UP = `${ESC_CHAR}[A`;
const DOWN = `${ESC_CHAR}[B`;
const ENTER = "\r";
const ESC = ESC_CHAR;

const ANSI_PATTERN = new RegExp(`${ESC_CHAR}\\[[0-9;?]*[A-Za-z]`, "g");
const stripAnsi = (text: string) => text.replace(ANSI_PATTERN, "");

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function makeTty() {
	const frames: string[] = [];
	const stdout = new Writable({
		write(chunk, _encoding, done) {
			frames.push(String(chunk));
			done();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	stdout.columns = 80;
	stdout.rows = 40;
	stdout.isTTY = true;
	const queue: string[] = [];
	const stdin = Object.assign(new EventEmitter(), {
		isTTY: true,
		setRawMode: () => stdin,
		ref: () => stdin,
		unref: () => stdin,
		read: () => (queue.length > 0 ? queue.shift() : null),
		setEncoding: () => stdin,
		resume: () => stdin,
		pause: () => stdin,
	});
	const press = (key: string) => {
		queue.push(key);
		stdin.emit("readable");
	};
	const lastFrame = () => {
		for (let i = frames.length - 1; i >= 0; i--) {
			const text = stripAnsi(frames[i] ?? "");
			if (text.trim().length > 0) return text;
		}
		return "";
	};
	const inputReady = () => stdin.listenerCount("readable") > 0;
	return { stdout, stdin, press, lastFrame, inputReady };
}

function renderPanel(state: SettingsState = BASE) {
	const tty = makeTty();
	const onToggle = mock((_id: SettingsToggleId) => {});
	const onOpenMemory = mock(() => {});
	const onClose = mock(() => {});
	const instance = render(
		React.createElement(SettingsPanel, {
			state,
			onToggle,
			onOpenMemory,
			onClose,
		}),
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin as unknown as NodeJS.ReadStream,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	const ready = () =>
		waitFor(() => tty.inputReady() && tty.lastFrame().includes("› Memory"));
	const selected = (label: string) =>
		waitFor(() => tty.lastFrame().includes(`› ${label}`));
	return {
		instance,
		press: tty.press,
		ready,
		selected,
		onToggle,
		onOpenMemory,
		onClose,
	};
}

describe("SettingsPanel interaction", () => {
	it("opens the memory selector when Enter is pressed on the initial row", async () => {
		const { instance, press, ready, onOpenMemory, onToggle } = renderPanel();
		await ready();
		press(ENTER);
		await waitFor(() => onOpenMemory.mock.calls.length === 1);
		instance.unmount();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("moves down to the first toggle row and dispatches its id on Enter", async () => {
		const { instance, press, ready, selected, onToggle, onOpenMemory } =
			renderPanel();
		await ready();
		press(DOWN);
		await selected("Verbose");
		press(ENTER);
		await waitFor(() => onToggle.mock.calls.length === 1);
		instance.unmount();
		expect(onToggle).toHaveBeenCalledWith("verbose");
		expect(onOpenMemory).not.toHaveBeenCalled();
	});

	it("wraps to the last row when moving up from the first", async () => {
		const { instance, press, ready, selected, onToggle } = renderPanel();
		await ready();
		press(UP);
		await selected("Discovery");
		press(ENTER);
		await waitFor(() => onToggle.mock.calls.length === 1);
		instance.unmount();
		expect(onToggle).toHaveBeenCalledWith("discover");
	});

	it("wraps back to the first row when moving down from the last", async () => {
		const { instance, press, ready, selected, onOpenMemory, onToggle } =
			renderPanel();
		await ready();
		press(UP);
		await selected("Discovery");
		press(DOWN);
		await selected("Memory");
		press(ENTER);
		await waitFor(() => onOpenMemory.mock.calls.length === 1);
		instance.unmount();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("ignores Enter on the LSP row while its toggle is pending", async () => {
		const { instance, press, ready, selected, onToggle } = renderPanel({
			...BASE,
			lspPending: true,
		});
		await ready();
		press(DOWN);
		await selected("Verbose");
		press(DOWN);
		await selected("Notify");
		press(DOWN);
		await selected("LSP");
		press(ENTER);
		press(DOWN);
		await selected("Browser");
		instance.unmount();
		expect(onToggle).not.toHaveBeenCalled();
	});

	it("closes the panel when Esc is pressed", async () => {
		const { instance, press, ready, onClose } = renderPanel();
		await ready();
		press(ESC);
		await waitFor(() => onClose.mock.calls.length === 1);
		instance.unmount();
	});
});
