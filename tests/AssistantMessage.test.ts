import { describe, expect, it } from "bun:test";
import { assistantWorkedLabel } from "../src/ui/components/AssistantMessage.tsx";

describe("AssistantMessage footer", () => {
	it("hides worked time before one minute", () => {
		expect(assistantWorkedLabel(59_999)).toBeNull();
	});

	it("shows worked time after one minute", () => {
		expect(assistantWorkedLabel(61_000)).toBe("Worked for 1m 01s");
	});
});
