import {
	isRetryableStreamServerError,
	streamRetryDelayMs,
	streamServerErrorRetries,
} from "../../providers/backboard/streamRetry.ts";
import type { ProviderEvent } from "../../providers/backboard/types.ts";
import { errorMessage } from "../../utils/errors.ts";
import type { EventBus } from "../bus/EventBus.ts";
import type { ToolCallRef } from "../bus/events.ts";
import type { Session } from "../session/Session.ts";
import { AbortError } from "../tools/ToolAbort.ts";
import type { EarlyToolSink } from "../tools/ToolScheduler.ts";
import type { AssistantAccumulator } from "./AssistantAccumulator.ts";

export interface PendingAction {
	runId: string | null;
	calls: ToolCallRef[];
}

class ProviderStreamFailure extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "ProviderStreamFailure";
	}
}

export class ProviderStreamConsumer {
	constructor(
		private readonly bus: EventBus,
		private readonly session: Session,
	) {}

	async consumeWithRetry(
		createStream: () => AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		signal: AbortSignal,
		earlyTools?: EarlyToolSink,
		onTerminalFailure?: () => Promise<string | null>,
	): Promise<PendingAction | null> {
		const maxRetries = streamServerErrorRetries();
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.consume(createStream(), assistant, earlyTools);
			} catch (err) {
				// Any stream failure resets the early round: it retracts announced
				// rows and aborts early runs. On a retry the round is reused for
				// the next attempt; on a terminal throw this is the only cleanup -
				// the caller never reaches process(), whose finally is the usual
				// one, and a stranded pending row would pin the live region
				// forever.
				earlyTools?.reset();
				const terminal =
					err instanceof AbortError ||
					signal.aborted ||
					!isRetryableProviderStreamFailure(err) ||
					attempt >= maxRetries;
				if (terminal) {
					if (!(err instanceof AbortError) && !signal.aborted) {
						await preserveProviderContext(
							this.bus,
							onTerminalFailure,
							"cancelled provider context",
						);
					}
					throw err;
				}
				assistant.discardPartial();
				try {
					await waitForRetry(streamRetryDelayMs(attempt + 1), signal);
				} catch (waitError) {
					await preserveProviderContext(
						this.bus,
						onTerminalFailure,
						"cancelled provider context",
					);
					throw waitError;
				}
			}
		}
	}

	private async consume(
		stream: AsyncIterable<ProviderEvent>,
		assistant: AssistantAccumulator,
		earlyTools?: EarlyToolSink,
	): Promise<PendingAction | null> {
		for await (const event of stream) {
			switch (event.kind) {
				case "thread":
					if (this.session.threadId !== event.threadId) {
						this.session.threadId = event.threadId;
						this.bus.emit({
							type: "session:thread",
							threadId: event.threadId,
						});
					}
					break;
				case "assistant_delta":
					if (event.text) assistant.appendDelta(event.text);
					break;
				case "tool_started":
					earlyTools?.announce(event.id, event.name);
					break;
				case "tool_ready":
					earlyTools?.offer({
						id: event.call.id,
						name: event.call.name,
						input: event.call.input,
					});
					break;
				case "usage":
					this.session.addUsage(event.usage);
					this.bus.emit({ type: "usage", usage: event.usage });
					break;
				case "warning":
					this.bus.emit({ type: "system:warning", message: event.message });
					break;
				case "requires_action": {
					const calls = event.calls.map((call) => ({
						id: call.id,
						name: call.name,
						input: call.input,
					}));
					assistant.finalize(calls);
					return { runId: event.runId, calls };
				}
				case "failed":
					throw new ProviderStreamFailure(
						event.error,
						event.retryable === true,
					);
				case "completed":
					assistant.finalize([], event.finalText);
					return null;
			}
		}
		throw new ProviderStreamFailure(
			"Provider stream closed unexpectedly before a terminal event.",
			true,
		);
	}
}

export async function preserveProviderContext(
	bus: EventBus,
	callback: (() => Promise<string | null>) | undefined,
	label: string,
): Promise<void> {
	if (!callback) return;
	try {
		const warning = await callback();
		if (warning) bus.emit({ type: "system:warning", message: warning });
	} catch (error) {
		bus.emit({
			type: "system:warning",
			message: `Failed to preserve ${label}: ${errorMessage(error)}`,
		});
	}
}

function isRetryableProviderStreamFailure(error: unknown): boolean {
	if (error instanceof ProviderStreamFailure) {
		return error.retryable || isRetryableStreamServerError(error);
	}
	return isRetryableStreamServerError(error);
}

async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	if (signal.aborted) throw new AbortError();
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new AbortError());
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
