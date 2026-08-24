import { describe, expect, it } from "bun:test";
import { render } from "ink";
import { buildContextReport } from "../src/core/context/ContextReport.ts";
import { userMessage } from "../src/core/session/Message.ts";
import { ContextPanel } from "../src/ui/components/ContextPanel.tsx";
import { TerminalSizeProvider } from "../src/ui/hooks/TerminalSizeContext.tsx";
import { stripAnsi } from "../src/utils/terminalSafe.ts";
import { makeInkTty } from "./inkHarness.ts";

function report(usedTokens: number, cachedTokens = 0) {
	return buildContextReport({
		model: { provider: "anthropic", model: "claude-opus-5" },
		source: "byok",
		systemPrompt: "You are a coding agent.",
		tools: [
			{
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object" },
				},
			},
		],
		messages: [userMessage("fix the bug")],
		todos: [],
		usedTokens,
		reportedLimit: null,
		cachedTokens,
		compactThresholdPercent: 85,
	});
}

function renderPanel(
	usedTokens: number,
	cachedTokens = 0,
	columns = 96,
): string {
	const tty = makeInkTty(columns, 40);
	const instance = render(
		<TerminalSizeProvider size={{ columns, rows: 40 }}>
			<ContextPanel
				report={report(usedTokens, cachedTokens)}
				onClose={() => {}}
			/>
		</TerminalSizeProvider>,
		{
			stdout: tty.stdout as unknown as NodeJS.WriteStream,
			stdin: tty.stdin,
			patchConsole: false,
			exitOnCtrlC: false,
		},
	);
	const frame = tty.written();
	instance.unmount();
	return frame;
}

describe("ContextPanel", () => {
	it("renders the window usage and the model", () => {
		const frame = renderPanel(50_000);

		expect(frame).toContain("Context");
		expect(frame).toContain("anthropic/claude-opus-5");
		expect(frame).toContain("your key");
		expect(frame).toContain("25%");
		expect(frame).toContain("200k");
	});

	it("labels the breakdown as estimated so it is not read as measured", () => {
		const frame = renderPanel(50_000);

		expect(frame).toContain("Breakdown (estimated)");
		expect(frame).toContain("System prompt");
		expect(frame).toContain("Tool definitions");
	});

	it("reports the cache share of the last request", () => {
		expect(renderPanel(100_000, 90_000)).toContain("90%");
		expect(renderPanel(100_000, 0)).toContain("no cached tokens");
	});

	it("shows where auto-compression sits, and that it is due once past it", () => {
		expect(renderPanel(50_000)).toContain("Auto-compress at 85%");
		expect(renderPanel(190_000)).toContain("compressing after the next turn");
	});

	it("keeps every rendered row inside a narrow terminal", () => {
		const frame = renderPanel(50_000, 0, 38);
		const visibleLines = frame
			.split("\n")
			.map((line) => stripAnsi(line))
			.filter((line) => line.trim());

		expect(
			Math.max(...visibleLines.map((line) => line.length)),
		).toBeLessThanOrEqual(38);
		expect(frame).toContain("anthropic/claude-opus-5");
		expect(frame).toContain("Tool definitions");
	});
});
