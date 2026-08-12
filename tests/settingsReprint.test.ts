import { describe, expect, it } from "bun:test";
import { shouldReprintOnSettingsExit } from "../src/ui/utils/settingsReprint.ts";

interface Step {
	mode: string;
	verbose: boolean;
	memoryReturnsToSettings?: boolean;
}

/**
 * Replays a sequence of mode transitions the way App.tsx's effect sees them:
 * `previousMode` threads from step to step and `verboseAtOpen` is the value
 * captured once when the panel opened. Returns how many reprints fire.
 */
function reprintsAcross(steps: Step[], verboseAtOpen: boolean): number {
	let previousMode = steps[0]?.mode ?? "normal";
	let count = 0;
	for (const step of steps.slice(1)) {
		if (
			shouldReprintOnSettingsExit({
				previousMode,
				mode: step.mode,
				memoryReturnsToSettings: step.memoryReturnsToSettings ?? false,
				verboseAtOpen,
				verboseNow: step.verbose,
			})
		) {
			count += 1;
		}
		previousMode = step.mode;
	}
	return count;
}

describe("shouldReprintOnSettingsExit", () => {
	it("reprints exactly once for a net verbose change across a settings → memory → settings → close round-trip", () => {
		const count = reprintsAcross(
			[
				{ mode: "normal", verbose: false },
				{ mode: "settings", verbose: false },
				{ mode: "settings", verbose: true },
				{ mode: "memory", verbose: true, memoryReturnsToSettings: true },
				{ mode: "settings", verbose: true },
				{ mode: "normal", verbose: true },
			],
			false,
		);
		expect(count).toBe(1);
	});

	it("reprints exactly once when verbose changes after returning from the memory selector", () => {
		const count = reprintsAcross(
			[
				{ mode: "normal", verbose: true },
				{ mode: "settings", verbose: true },
				{ mode: "memory", verbose: true, memoryReturnsToSettings: true },
				{ mode: "settings", verbose: true },
				{ mode: "settings", verbose: false },
				{ mode: "normal", verbose: false },
			],
			true,
		);
		expect(count).toBe(1);
	});

	it("does not reprint when verbose toggles net out before closing", () => {
		const count = reprintsAcross(
			[
				{ mode: "normal", verbose: false },
				{ mode: "settings", verbose: false },
				{ mode: "settings", verbose: true },
				{ mode: "settings", verbose: false },
				{ mode: "normal", verbose: false },
			],
			false,
		);
		expect(count).toBe(0);
	});

	it("does not reprint when toggles net out across a memory round-trip", () => {
		const count = reprintsAcross(
			[
				{ mode: "normal", verbose: false },
				{ mode: "settings", verbose: false },
				{ mode: "settings", verbose: true },
				{ mode: "memory", verbose: true, memoryReturnsToSettings: true },
				{ mode: "settings", verbose: true },
				{ mode: "settings", verbose: false },
				{ mode: "normal", verbose: false },
			],
			false,
		);
		expect(count).toBe(0);
	});

	it("does not reprint on the hop into the memory selector", () => {
		expect(
			shouldReprintOnSettingsExit({
				previousMode: "settings",
				mode: "memory",
				memoryReturnsToSettings: true,
				verboseAtOpen: false,
				verboseNow: true,
			}),
		).toBe(false);
	});

	it("does not reprint when closing with verbose unchanged", () => {
		expect(
			shouldReprintOnSettingsExit({
				previousMode: "settings",
				mode: "normal",
				memoryReturnsToSettings: false,
				verboseAtOpen: true,
				verboseNow: true,
			}),
		).toBe(false);
	});

	it("does not reprint on transitions that do not leave settings", () => {
		expect(
			shouldReprintOnSettingsExit({
				previousMode: "normal",
				mode: "settings",
				memoryReturnsToSettings: false,
				verboseAtOpen: false,
				verboseNow: true,
			}),
		).toBe(false);
		expect(
			shouldReprintOnSettingsExit({
				previousMode: "settings",
				mode: "settings",
				memoryReturnsToSettings: false,
				verboseAtOpen: false,
				verboseNow: true,
			}),
		).toBe(false);
	});
});
