import { describe, expect, it } from "bun:test";
import { formatThinkingAmount } from "../src/ui/components/StatusBar.tsx";

describe("StatusBar", () => {
	it("formats thinking amounts for the footer", () => {
		expect(formatThinkingAmount(null)).toBeNull();
		expect(formatThinkingAmount(undefined)).toBeNull();
		expect(formatThinkingAmount({ effort: "low" })).toBe("low");
		expect(formatThinkingAmount({ effort: "medium" })).toBe("medium");
		expect(formatThinkingAmount({ effort: "high" })).toBe("high");
		expect(formatThinkingAmount({ effort: "max" })).toBe("xhigh");
		expect(formatThinkingAmount({ budget_tokens: 4096 })).toBe("4096 tokens");
		expect(formatThinkingAmount({ max_tokens: 8192 })).toBe("8192 tokens");
		expect(formatThinkingAmount({ kind: "dynamic" })).toBe("dynamic");
	});
});
