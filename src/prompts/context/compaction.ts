import type { CompactionRequestInput } from "./compaction.types.ts";

/**
 * The compaction prompt.
 *
 * A compressed transcript is not a summary for a human - it is the agent's
 * entire working memory for everything that follows. So the target is not
 * brevity, it is *resumability*: after compression the agent must be able to
 * carry on as if it still had the full history, and any detail it would have
 * to guess at is a detail the compression lost.
 *
 * Three failure modes drive the structure below:
 *
 *   1. Losing identifiers. Paraphrase destroys exact paths, symbols, commands,
 *      error strings, and ids - the things the agent cannot re-derive and will
 *      instead hallucinate. These are required verbatim.
 *   2. Losing the "why". A record of what changed, without the constraints and
 *      rejected alternatives behind it, invites the agent to redo settled work
 *      or re-break something that was deliberately fixed.
 *   3. Losing the live edge. Whatever was mid-flight when compression ran is
 *      the single most important thing to preserve, and is exactly what a
 *      chronological summary buries at the end.
 *
 * The section order below is deliberate: state, then history. An agent reading
 * top-down should know what it is doing now before it learns how it got here.
 */

export const COMPACTION_SYSTEM_PROMPT = `You compress a software engineering session into a handoff document.

The engineer reading it has no memory of the session and cannot see the original transcript. Everything they need to continue must be in what you write. Treat any omission as permanently lost.

Absolute rules:
- Reproduce identifiers EXACTLY: file paths, function and type names, commands, flags, environment variables, error text, URLs, ids, and version numbers. Never paraphrase, abbreviate, or "clean up" one of these.
- Never invent. If something was attempted but the outcome never appeared, say the outcome is unknown. An honest gap is recoverable; a confident guess is not.
- Preserve decisions together with their reasons and their rejected alternatives, so settled questions stay settled.
- Preserve the user's own words for their goals and corrections. A restated instruction drifts.
- Prefer specifics over characterization. "Tests fail at auth.test.ts:88 with 'expected 401, got 500'" is useful; "some tests are failing" is not.
- Length follows content. Compress ruthlessly where the session was repetitive; stay long where it was dense.

Write the document inside <handoff> tags, using these sections:

<handoff>
## Objective
What the user is ultimately trying to achieve, in their framing. Quote the exact wording of the original request and of any correction that redirected the work.

## Current State
What is true right now: what is built and verified, what is built but unverified, what is known broken. Be precise about which is which.

## Active Work
The task in flight when this document was written, and how far it got. If a tool call, edit, or command was in progress or its result unseen, say so explicitly. If nothing was in flight, say so.

## Next Steps
Ordered, concrete actions to take next, with enough detail to execute without rediscovery. Mark anything blocked and name the blocker.

## Files Touched
Every file created, edited, or centrally examined. One line each: absolute path, then what changed in it and why. Include key symbol names.

## Technical Decisions
Choices made and the constraint or reasoning behind each. Include approaches that were tried and abandoned, and why, so they are not retried.

## Problems and Resolutions
Errors, failures, and surprises encountered. For each: the exact error or symptom, the cause if it was established, and the fix or current status. Keep unresolved items clearly unresolved.

## Environment
Commands that must be run a particular way, tooling quirks, paths, credentials or config that matter, and anything discovered about the environment the hard way.

## History
A condensed chronological pass over the session: user requests, the agent's approach, and the significant tool actions and their outcomes, in order. Collapse repetition into a single line noting how many times it happened.
</handoff>`;

export function buildCompactionRequest(input: CompactionRequestInput): string {
	const sections = [
		"Compress the session below into the handoff document.",
		"",
		"<transcript>",
		input.transcript,
		"</transcript>",
	];
	if (input.todos.trim()) {
		sections.push(
			"",
			"The task list at the moment of compression. Reflect its live state in Active Work and Next Steps:",
			"<todos>",
			input.todos,
			"</todos>",
		);
	}
	if (input.verbatimTurns > 0) {
		sections.push(
			"",
			`Note: the last ${input.verbatimTurns} exchange(s) are also being carried forward word-for-word alongside your document, so summarize them only briefly - spend your effort on the earlier history that is about to be discarded.`,
		);
	}
	return sections.join("\n");
}

/**
 * Frames the handoff for the resumed conversation. The agent is told plainly
 * that this replaces the earlier history - without that, models tend to open
 * the next turn by re-narrating the summary back to the user.
 */
export function buildResumeContext(
	handoff: string,
	verbatimTail: string,
	transcriptPath?: string,
): string {
	const parts = [
		"The earlier part of this conversation was compressed to free context. The handoff below is your memory of it - treat it as established fact you already know, not as new information from the user.",
		"",
		handoff.trim(),
	];
	if (verbatimTail.trim()) {
		parts.push(
			"",
			"The most recent exchanges, carried forward word-for-word:",
			"",
			verbatimTail.trim(),
		);
	}
	if (transcriptPath) {
		// A summary is lossy by construction. Naming the full transcript turns
		// "that detail is gone" into "that detail is one read away" - the exact
		// command, the exact error text, the file that was open three hours ago.
		parts.push(
			"",
			`The uncompressed transcript of everything before this point is at ${transcriptPath} (JSONL, one event per line, oldest first). Read it when you need a detail the handoff does not carry - an exact error, a command you ran, a path you touched. Prefer it over asking the user to repeat themselves.`,
		);
	}
	parts.push(
		"",
		"Continue the work from here. Do not summarize this back to the user or announce that compression happened - just carry on.",
	);
	return parts.join("\n");
}

/** Pulls the document out of its tags, tolerating a model that omits them. */
export function extractHandoff(text: string): string {
	const match = text.match(/<handoff>([\s\S]*?)<\/handoff>/i);
	if (match?.[1]?.trim()) return match[1].trim();
	// Some models drop the closing tag on long outputs; take everything after
	// the opener rather than throwing away a perfectly good summary.
	const opener = text.match(/<handoff>([\s\S]*)/i);
	if (opener?.[1]?.trim()) return opener[1].trim();
	return text.trim();
}
