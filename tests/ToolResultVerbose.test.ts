import { describe, expect, it } from "bun:test";
import { renderToString } from "ink";
import React from "react";
import { ToolResultView } from "../src/ui/components/ToolResultView.tsx";
import { VerboseProvider } from "../src/ui/hooks/VerboseContext.tsx";

function render(verbose: boolean): string {
	return renderToString(
		React.createElement(
			VerboseProvider,
			{ verbose },
			React.createElement(ToolResultView, {
				status: "done",
				title: "Found 3 files",
				detail: "a.ts\nb.ts\nc.ts",
			}),
		),
	);
}

describe("ToolResultView verbose gating", () => {
	it("shows the detail preview when verbose is on", () => {
		const output = render(true);
		expect(output).toContain("Found 3 files");
		expect(output).toContain("a.ts");
		expect(output).toContain("c.ts");
	});

	it("hides the detail preview but keeps the title when verbose is off", () => {
		const output = render(false);
		expect(output).toContain("Found 3 files");
		expect(output).not.toContain("a.ts");
		expect(output).not.toContain("c.ts");
	});
});
