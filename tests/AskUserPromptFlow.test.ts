import { describe, expect, it } from "bun:test";
import { render } from "ink";
import React from "react";
import type { AskUserRequest } from "../src/core/bus/events.ts";
import { AskUserPrompt } from "../src/ui/components/AskUserPrompt.tsx";
import { makeInkTty } from "./inkHarness.ts";

const ESC = String.fromCharCode(27);
const KEY = {
	up: `${ESC}[A`,
	down: `${ESC}[B`,
	right: `${ESC}[C`,
	left: `${ESC}[D`,
	enter: String.fromCharCode(13),
	del: `${ESC}[3~`,
	backspace: String.fromCharCode(127),
};

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Render the prompt and return a `send()` that feeds keystrokes plus the
 * captured completion answers. */
function mount(request: AskUserRequest) {
	const tty = makeInkTty();
	let completed: string[] | null = null;
	const instance = render(
		React.createElement(AskUserPrompt, {
			request,
			onComplete: (_id, answers) => {
				completed = answers;
			},
		}),
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	const send = async (...keys: string[]): Promise<void> => {
		for (const key of keys) {
			tty.feed(key);
			await sleep(10);
		}
	};
	return {
		send,
		feed: tty.feed,
		answers: () => completed,
		unmount: instance.unmount,
	};
}

const twoQuestions: AskUserRequest = {
	id: "ask_flow",
	questions: [
		{ header: "First", question: "Pick first", options: ["A", "B"] },
		{ header: "Second", question: "Pick second", options: ["X", "Y"] },
	],
};

describe("AskUserPrompt keyboard flow", () => {
	it("confirms each question in turn and submits the chosen options", async () => {
		const ui = mount(twoQuestions);
		await sleep(10);
		// Highlight B on question 1, confirm, then confirm question 2's default X.
		await ui.send(KEY.down, KEY.enter, KEY.enter);
		expect(ui.answers()).toEqual(["B", "X"]);
		ui.unmount();
	});

	it("does not submit until every question has been confirmed", async () => {
		const ui = mount(twoQuestions);
		await sleep(10);
		await ui.send(KEY.enter); // confirms only question 1
		expect(ui.answers()).toBeNull();
		await ui.send(KEY.enter); // confirms question 2 -> now complete
		expect(ui.answers()).toEqual(["A", "X"]);
		ui.unmount();
	});

	it("switches questions with left/right at the answer boundary", async () => {
		const ui = mount(twoQuestions);
		await sleep(10);
		// Empty draft: right moves to question 2, pick Y, confirm; wraps to
		// question 1, confirm its default A.
		await ui.send(KEY.right, KEY.down, KEY.enter, KEY.enter);
		expect(ui.answers()).toEqual(["A", "Y"]);
		ui.unmount();
	});

	it("edits a custom answer mid-string with cursor movement", async () => {
		const ui = mount({
			id: "ask_edit",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// Type "hllo", move cursor back to just after "h", insert "e" -> "hello".
		await ui.send("h", "l", "l", "o", KEY.left, KEY.left, KEY.left, "e");
		await ui.send(KEY.enter);
		expect(ui.answers()).toEqual(["hello"]);
		ui.unmount();
	});

	it("keeps every character when keystrokes arrive in one tick", async () => {
		const ui = mount({
			id: "ask_burst",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// Fire two input events synchronously (no render between) — the classic
		// stale-closure drop. Both must survive.
		ui.feed("a");
		ui.feed("b");
		await sleep(15);
		await ui.send(KEY.enter);
		expect(ui.answers()).toEqual(["ab"]);
		ui.unmount();
	});

	it("keeps a typed answer when input and Enter share a tick", async () => {
		const ui = mount({
			id: "ask_confirm",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// Type then confirm in the same batch — submit must see the typed draft,
		// not fall back to the highlighted option.
		ui.feed("foo");
		ui.feed(KEY.enter);
		await sleep(20);
		expect(ui.answers()).toEqual(["foo"]);
		ui.unmount();
	});

	it("drops control characters pasted into the answer", async () => {
		const ui = mount({
			id: "ask_paste",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// A paste with an embedded newline must not corrupt the single-line field.
		await ui.send(`foo${String.fromCharCode(10)}bar`);
		await ui.send(KEY.enter);
		expect(ui.answers()).toEqual(["foobar"]);
		ui.unmount();
	});

	it("backspaces the character before the cursor", async () => {
		const ui = mount({
			id: "ask_bs",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// Type "hix", backspace once -> "hi".
		await ui.send("h", "i", "x", KEY.backspace);
		await ui.send(KEY.enter);
		expect(ui.answers()).toEqual(["hi"]);
		ui.unmount();
	});

	it("locks a confirmed answer even if its state changes later", async () => {
		const ui = mount(twoQuestions);
		await sleep(10);
		// Confirm Q1 as "B", jump back and move the highlight to A without
		// re-confirming, then confirm Q2. Q1 must submit the snapshotted "B".
		await ui.send(KEY.down, KEY.enter); // Q1 -> "B", advance to Q2
		await ui.send(KEY.left, KEY.up, KEY.right); // back to Q1, change to A, return
		await ui.send(KEY.enter); // confirm Q2's default X -> submit
		expect(ui.answers()).toEqual(["B", "X"]);
		ui.unmount();
	});

	it("forward-deletes the character under the cursor", async () => {
		const ui = mount({
			id: "ask_del",
			questions: [
				{ header: "Name", question: "Your name?", options: ["skip"] },
			],
		});
		await sleep(10);
		// Type "hello", move left once (cursor before "o"), forward-delete -> "hell".
		await ui.send("h", "e", "l", "l", "o", KEY.left, KEY.del);
		await ui.send(KEY.enter);
		expect(ui.answers()).toEqual(["hell"]);
		ui.unmount();
	});
});
