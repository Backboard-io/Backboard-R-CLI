import type { ModelRef } from "../../config/defaults.ts";
import type { TodoItem } from "../bus/events.ts";
import type { Message } from "../session/Message.ts";
import type { OpenAITool } from "../tools/schema.ts";
import { resolveContextWindow } from "./ContextWindow.ts";
import {
	estimateJsonTokens,
	estimateMessageTokens,
	estimateTokens,
} from "./tokens.ts";

export interface ContextSegment {
	label: string;
	tokens: number;
	detail?: string;
}

export interface ContextReport {
	model: ModelRef;
	/** "byok" or "backboard" - which backend the next turn will bill. */
	source: string;
	limit: number;
	/** Provider-measured prompt size for the last turn, or 0 before any turn. */
	usedTokens: number;
	/** True when usedTokens came from the provider rather than local estimation. */
	measured: boolean;
	percent: number;
	segments: ContextSegment[];
	/** Sum of the estimated segments; may differ from usedTokens. */
	estimatedTotal: number;
	cachedTokens: number;
	cachedPercent: number;
	compactThresholdPercent: number;
	compactAtTokens: number;
	messageCount: number;
}

export interface BuildContextReportInput {
	model: ModelRef;
	source: string;
	systemPrompt: string;
	tools: readonly OpenAITool[];
	messages: readonly Message[];
	todos: readonly TodoItem[];
	/** Provider-reported prompt tokens for the last turn. */
	usedTokens: number;
	/** Provider-reported window, when the backend supplies one. */
	reportedLimit: number | null;
	cachedTokens: number;
	compactThresholdPercent: number;
}

/**
 * Builds the `/context` readout.
 *
 * Two different kinds of number live here and the distinction matters. The
 * total is *measured* - what the provider says the last request actually cost.
 * The per-segment split is *estimated*, because no provider reports a
 * breakdown. Rendering marks the estimates so the two are never confused; the
 * point of the breakdown is proportion ("tool results are eating the window"),
 * not precision.
 */
export function buildContextReport(
	input: BuildContextReportInput,
): ContextReport {
	const limit = resolveContextWindow(input.model, input.reportedLimit);

	const systemTokens = estimateTokens(input.systemPrompt);
	const toolTokens = input.tools.reduce(
		(sum, tool) =>
			sum +
			estimateTokens(tool.function.name) +
			estimateTokens(tool.function.description) +
			estimateJsonTokens(tool.function.parameters),
		0,
	);
	const todoTokens = input.todos.reduce(
		(sum, todo) => sum + estimateTokens(todo.content) + 6,
		0,
	);

	let userTokens = 0;
	let assistantTokens = 0;
	let toolResultTokens = 0;
	for (const message of input.messages) {
		if (message.role === "user") {
			userTokens += estimateMessageTokens(message.text);
			continue;
		}
		if (message.role === "assistant") {
			assistantTokens += estimateMessageTokens(message.text);
			for (const call of message.toolCalls) {
				assistantTokens +=
					estimateTokens(call.name) + estimateJsonTokens(call.input);
			}
			continue;
		}
		for (const result of message.results) {
			toolResultTokens += estimateMessageTokens(String(result.output ?? ""));
		}
	}

	const segments: ContextSegment[] = [
		{ label: "System prompt", tokens: systemTokens },
		{
			label: "Tool definitions",
			tokens: toolTokens,
			detail: `${input.tools.length} tools`,
		},
		{ label: "Your messages", tokens: userTokens },
		{ label: "Agent messages", tokens: assistantTokens },
		{ label: "Tool results", tokens: toolResultTokens },
	];
	if (input.todos.length > 0) {
		segments.push({
			label: "Task list",
			tokens: todoTokens,
			detail: `${input.todos.length} items`,
		});
	}

	const estimatedTotal = segments.reduce(
		(sum, segment) => sum + segment.tokens,
		0,
	);
	// Before the first turn reports usage there is nothing measured to show, so
	// fall back to the estimate rather than claiming the window is empty.
	const measured = input.usedTokens > 0;
	const usedTokens = measured ? input.usedTokens : estimatedTotal;

	return {
		model: input.model,
		source: input.source,
		limit,
		usedTokens,
		measured,
		percent: limit > 0 ? (usedTokens / limit) * 100 : 0,
		segments,
		estimatedTotal,
		cachedTokens: input.cachedTokens,
		cachedPercent: usedTokens > 0 ? (input.cachedTokens / usedTokens) * 100 : 0,
		compactThresholdPercent: input.compactThresholdPercent,
		compactAtTokens: Math.round((limit * input.compactThresholdPercent) / 100),
		messageCount: input.messages.length,
	};
}
