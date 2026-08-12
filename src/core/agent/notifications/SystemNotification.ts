import type {
	ThinkingConfig,
	ThinkingRequestKind,
} from "../../../config/defaults.ts";
import type { TodoItem } from "../../bus/events.ts";
import type { OpenAITool } from "../../tools/schema.ts";

/**
 * Metadata key stamped on an injected notification's request message. The
 * server persists it and returns it on resume; its value is the notification's
 * `id`. Lets the server prune injected turns during context compaction and
 * lets resume drop them without brittle text matching.
 */
export const INJECTED_NOTIFICATION_METADATA_KEY = "injected_notification";

/**
 * Live turn state a notification consults to decide whether to fire. The
 * counters come straight from the turn's ToolRoundProcessor and the todos
 * from the session, so the same snapshot shape serves both the pre-finalize
 * suppression check and the post-loop injection check.
 */
export interface SystemNotificationContext {
	requestKind: ThinkingRequestKind;
	executedRounds: number;
	executedToolCalls: number;
	todos: readonly TodoItem[];
}

/**
 * A system-injected follow-up to the tool loop: once the loop finishes, each
 * notification that fires sends its content as a synthetic user-role turn on
 * the same thread (same system prompt, same tools) and processes the response
 * through the turn's existing stream consumer and tool-round processor, so
 * the model can keep using tools. The final-verification nudge is the
 * canonical instance; todo reminders and future nudges plug in the same way.
 */
export interface SystemNotification {
	/** Stable identifier, e.g. "final-verification". */
	readonly id: string;

	/**
	 * When true, a final (no-tool-call) answer streamed before this
	 * notification fires is buffered and discarded: the notification's
	 * response supersedes it as the turn's shown summary.
	 */
	readonly supersedesFinalAnswer: boolean;

	/**
	 * When true, assistant text streamed in response to this notification is
	 * hidden from the UI (still persisted to the session so the model keeps
	 * its own words in context). Use for bookkeeping exchanges - e.g. the todo
	 * reconciliation reminder, whose reply is a TodoWrite call or an exact
	 * "Plan is up-to-date." sentinel the user should never see.
	 */
	readonly hidesResponse: boolean;

	/**
	 * Whether to inject this notification for the given turn state. Both the
	 * runner and the final-answer suppression predicate call this, so keep it
	 * pure — it may run several times per turn against live counters.
	 */
	shouldFire(context: SystemNotificationContext): boolean;

	/** Provider-visible text injected as the synthetic user turn. */
	content(context: SystemNotificationContext): string;

	/**
	 * How many times this notification may fire in one turn. The runner
	 * repeats while `shouldFire` stays true, stopping early if a pass produces
	 * the same `content` as the previous one (the model didn't move the state
	 * the notification reacts to). Defaults to 1 (fire once). The todo reminder
	 * sets this above 1 to loop until every todo is closed.
	 */
	readonly maxRepeats?: number;

	/**
	 * Optional narrowing of the tool schemas offered to this notification's
	 * turn. The reconciliation reminder restricts itself to TodoWrite so a
	 * non-compliant reply cannot do real work invisibly. Omit to offer the
	 * turn's full tool set.
	 */
	restrictTools?(tools: readonly OpenAITool[]): OpenAITool[];

	/**
	 * Thinking override for the injected request: `null` disables thinking
	 * (bookkeeping turns should not burn reasoning tokens); omit to keep the
	 * provider default.
	 */
	readonly thinking?: ThinkingConfig | null;
}
