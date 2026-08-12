import { describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { render } from "ink";
import React from "react";
import { useLspToggle } from "../src/ui/hooks/useLspToggle.ts";

interface Handle {
	toggleLsp: (opts?: { silent?: boolean }) => void;
	lspPending: boolean;
}

interface ProbeProps {
	lsp: { toggleEnabled: () => Promise<boolean> };
	notice: (text: string, level?: "info" | "warning" | "error") => void;
	onRender: (handle: Handle) => void;
}

function Probe({ lsp, notice, onRender }: ProbeProps): null {
	onRender(useLspToggle(lsp, notice));
	return null;
}

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
	const stdout = new Writable({
		write(_chunk, _encoding, done) {
			done();
		},
	}) as Writable & { columns: number; rows: number; isTTY: boolean };
	stdout.columns = 80;
	stdout.rows = 40;
	stdout.isTTY = true;
	const stdin = Object.assign(new EventEmitter(), {
		isTTY: true,
		setRawMode: () => stdin,
		ref: () => stdin,
		unref: () => stdin,
		read: () => null,
		setEncoding: () => stdin,
		resume: () => stdin,
		pause: () => stdin,
	});
	return { stdout, stdin };
}

function renderProbe(
	toggleEnabled: () => Promise<boolean>,
	notice: ProbeProps["notice"] = () => {},
) {
	const tty = makeTty();
	let handle: Handle | null = null;
	const instance = render(
		React.createElement(Probe, {
			lsp: { toggleEnabled },
			notice,
			onRender: (next) => {
				handle = next;
			},
		}),
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin as unknown as NodeJS.ReadStream,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	return {
		instance,
		handle: () => {
			if (!handle) throw new Error("Probe has not rendered yet");
			return handle;
		},
		ready: () => waitFor(() => handle !== null),
	};
}

describe("useLspToggle", () => {
	it("starts a single toggle when invoked twice before the first resolves", async () => {
		let resolveToggle!: (enabled: boolean) => void;
		const toggleEnabled = mock(
			() =>
				new Promise<boolean>((resolve) => {
					resolveToggle = resolve;
				}),
		);
		const { instance, handle, ready } = renderProbe(toggleEnabled);
		await ready();

		handle().toggleLsp({ silent: true });
		handle().toggleLsp({ silent: true });
		expect(toggleEnabled.mock.calls.length).toBe(1);
		await waitFor(() => handle().lspPending);

		resolveToggle(true);
		await waitFor(() => !handle().lspPending);

		handle().toggleLsp({ silent: true });
		expect(toggleEnabled.mock.calls.length).toBe(2);
		instance.unmount();
	});

	it("notices the new state unless silent", async () => {
		const notice = mock(
			(_text: string, _level?: "info" | "warning" | "error") => {},
		);
		const { instance, handle, ready } = renderProbe(
			() => Promise.resolve(true),
			notice,
		);
		await ready();

		handle().toggleLsp();
		await waitFor(() => notice.mock.calls.length === 1);
		expect(notice.mock.calls[0]?.[0]).toBe(
			"LSP diagnostics enabled for this session.",
		);
		await waitFor(() => !handle().lspPending);

		handle().toggleLsp({ silent: true });
		await waitFor(() => !handle().lspPending);
		expect(notice.mock.calls.length).toBe(1);
		instance.unmount();
	});

	it("notices the failure, clears pending, and allows another toggle", async () => {
		const notice = mock(
			(_text: string, _level?: "info" | "warning" | "error") => {},
		);
		let attempts = 0;
		const toggleEnabled = mock(() => {
			attempts += 1;
			return attempts === 1
				? Promise.reject(new Error("boom"))
				: Promise.resolve(false);
		});
		const { instance, handle, ready } = renderProbe(toggleEnabled, notice);
		await ready();

		handle().toggleLsp();
		await waitFor(() => notice.mock.calls.length === 1);
		expect(notice.mock.calls[0]?.[0]).toBe(
			"Failed to toggle LSP diagnostics: boom",
		);
		expect(notice.mock.calls[0]?.[1]).toBe("error");
		await waitFor(() => !handle().lspPending);

		handle().toggleLsp();
		await waitFor(() => notice.mock.calls.length === 2);
		expect(notice.mock.calls[1]?.[0]).toBe(
			"LSP diagnostics disabled for this session.",
		);
		instance.unmount();
	});
});
