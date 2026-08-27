#!/usr/bin/env bun
/**
 * Interactive smoke test for local computer use. Drives the real platform
 * (compiled Swift helper on macOS, PowerShell host on Windows) through the
 * ComputerTool: opens TextEdit/Notepad, types a sentence, confirms via the
 * accessibility tree that the text landed, then closes the window without
 * saving. Prints per-action timings.
 *
 * This moves your mouse and types into a real app — run it when you are not
 * using the machine:
 *
 *   bun run scripts/cua-smoke.ts
 */
import { EventBus } from "../src/core/bus/EventBus.ts";
import { ComputerRuntime } from "../src/core/computer/ComputerRuntime.ts";
import type {
	ComputerAction,
	ComputerQueueResult,
} from "../src/core/computer/ComputerTypes.ts";
import type { ToolContext } from "../src/core/tools/ToolContext.ts";
import { ComputerTool } from "../src/tools/ComputerTool.tsx";

const SENTENCE = `Backboard CUA smoke ${new Date().toISOString().slice(11, 19)}`;
const isMac = process.platform === "darwin";
const editor = isMac ? "TextEdit" : "notepad";
const meta = isMac ? "cmd" : "ctrl";

const runtime = new ComputerRuntime();
const tool = new ComputerTool(runtime);
const ctx: ToolContext = {
	sessionId: "cua-smoke",
	cwd: process.cwd(),
	bus: new EventBus(),
	signal: new AbortController().signal,
	askUser: async () => "",
};

let failures = 0;

async function step(
	label: string,
	actions: ComputerAction[],
): Promise<ComputerQueueResult> {
	const started = performance.now();
	const result = await tool.execute({ actions }, ctx);
	const data = result.data;
	const ms = Math.round(performance.now() - started);
	process.stdout.write(
		`\n=== ${label} — ${data.success ? "ok" : "FAILED"} in ${ms}ms (actions ${data.timing.actionsMs}ms, settle ${data.timing.settleMs}ms${data.timing.settled === false ? " timeout" : ""}, observe ${data.timing.observeMs}ms)\n`,
	);
	for (const entry of data.results) {
		process.stdout.write(
			`  ${entry.success ? "✓" : "✗"} ${entry.action.padEnd(10)} ${entry.durationMs}ms  ${entry.summary}${entry.error ? ` — ${entry.error}` : ""}\n`,
		);
	}
	const obs = data.observation;
	if (obs) {
		process.stdout.write(
			`  screen ${obs.appName ?? "?"} / ${obs.windowTitle ?? "?"} · ${obs.screenSize.width}x${obs.screenSize.height} pts → ${obs.imageSize.width}x${obs.imageSize.height} px · ${obs.elements.length} elements · ${Math.round(((obs.__image_base64?.length ?? 0) * 0.75) / 1024)} KB\n`,
		);
	}
	if (!data.success) failures++;
	return data;
}

try {
	const opened = await step("open editor and create a document", [
		{ action: "openApp", appName: editor },
		...(isMac ? [{ action: "key" as const, key: "cmd+n" }] : []),
	]);
	if (
		!opened.observation?.appName?.toLowerCase().includes(editor.toLowerCase())
	) {
		process.stdout.write(
			`  ! frontmost app is ${opened.observation?.appName ?? "unknown"}, expected ${editor}\n`,
		);
	}

	const typed = await step("type a sentence and select all", [
		{ action: "type", text: SENTENCE },
		{ action: "key", key: `${meta}+a` },
	]);
	const textArea = typed.observation?.elements.find(
		(element) =>
			/TextArea|Document|Edit/i.test(element.role) &&
			(element.value ?? element.name ?? "").includes(SENTENCE),
	);
	if (textArea) {
		process.stdout.write(
			`  ✓ accessibility tree shows the typed text in ${textArea.role} ${textArea.id}\n`,
		);
	} else {
		failures++;
		process.stdout.write(
			"  ✗ typed text not found in the accessibility tree\n",
		);
	}

	if (typed.observation) {
		const zoomed = await step("zoom into the document", [
			{
				action: "zoom",
				region: {
					x: textArea?.bounds?.x ?? 0,
					y: textArea?.bounds?.y ?? 0,
					width: Math.min(600, textArea?.bounds?.width ?? 600),
					height: Math.min(120, textArea?.bounds?.height ?? 120),
				},
			},
		]);
		if (!zoomed.observation?.region) {
			failures++;
			process.stdout.write("  ✗ zoom observation has no region\n");
		}
	}

	await step("scroll and move", [
		{ action: "scroll", direction: "down", amount: 2 },
		{ action: "move", target: { x: 20, y: 20 } },
	]);

	const closing = await step("close the document", [
		{ action: "key", key: `${meta}+w` },
	]);
	const dontSave = closing.observation?.elements.find((element) =>
		/^(don.?t save|discard|delete)$/i.test(element.name ?? ""),
	);
	if (dontSave) {
		await step("dismiss the save sheet by element id", [
			{ action: "click", target: { elementId: dontSave.id } },
		]);
	} else if (closing.observation?.modal) {
		failures++;
		process.stdout.write(
			"  ✗ save sheet is open but no Don't Save button was found\n",
		);
	}
} finally {
	await tool.dispose();
}

process.stdout.write(
	`\n${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures})`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
