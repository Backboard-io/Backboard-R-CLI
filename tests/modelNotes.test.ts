import { describe, expect, it } from "bun:test";
import { composeSubmissionWithNotes } from "../src/ui/utils/modelNotes.ts";

describe("composeSubmissionWithNotes", () => {
	it("passes text through untouched when no notes are pending", () => {
		const composed = composeSubmissionWithNotes("hello", [], { steer: false });
		expect(composed.modelText).toBe("hello");
		expect(composed.emitUserMessage).toBe(true);
		expect(composed.emitTranscriptText).toBeNull();
		expect(composed.consumedNotes).toBe(false);
	});

	it("prefixes notes for the model but keeps the transcript clean", () => {
		const note = "<system-reminder>files reverted</system-reminder>";
		const composed = composeSubmissionWithNotes("fix it", [note], {
			steer: false,
		});
		expect(composed.modelText).toBe(`${note}\n\nfix it`);
		// Exactly one visible user message: the caller emits the clean text and
		// the controller must not emit a second (note-polluted) one.
		expect(composed.emitTranscriptText).toBe("fix it");
		expect(composed.emitUserMessage).toBe(false);
		expect(composed.consumedNotes).toBe(true);
	});

	it("joins multiple notes in order", () => {
		const composed = composeSubmissionWithNotes("go", ["a", "b"], {
			steer: false,
		});
		expect(composed.modelText).toBe("a\n\nb\n\ngo");
	});

	it("holds notes back for steering so they wait for the next turn", () => {
		const composed = composeSubmissionWithNotes("steer", ["note"], {
			steer: true,
		});
		expect(composed.modelText).toBe("steer");
		expect(composed.emitUserMessage).toBe(true);
		expect(composed.emitTranscriptText).toBeNull();
		expect(composed.consumedNotes).toBe(false);
	});
});
